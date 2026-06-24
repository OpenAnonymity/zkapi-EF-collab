use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use starknet_types_core::curve::ProjectivePoint;
use tempfile::TempDir;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use zkapi_client::config::{ClientConfig, ClientProofMode};
use zkapi_client::journal::PendingRequestJournal;
use zkapi_client::note_state::NoteState;
use zkapi_core::commitment::{
    compute_blind_delta, compute_clearance_message, compute_next_anchor, compute_state_message,
};
use zkapi_core::leaf::{compute_note_leaf, compute_registration_commitment};
use zkapi_core::merkle::MerkleTree;
use zkapi_core::poseidon::{felt_to_field, field_to_felt, poseidon_hash, FieldElement};
use zkapi_crypto::pedersen::PedersenCommitment;
use zkapi_crypto::xmss::XmssKeypair;
use zkapi_proof::{verify_request_proof, RequestProofBuilder};
use zkapi_types::domain::{DOMAIN_ANCHOR, DOMAIN_BLIND};
use zkapi_types::wire::{
    ApiRequest, ClearanceRequest, ClearanceResponse, CurvePointWire, ErrorResponse,
    ProofArtifactWire, ProofBackendWire, RecoveryResponse, RequestResponse,
};
use zkapi_types::{
    canonical_response_hash, EpochRoots, Felt252, RequestPublicInputs, MERKLE_DEPTH,
};

pub const TEST_PROTOCOL_VERSION: u16 = 1;
pub const TEST_CHAIN_ID: u64 = 31337;
pub const TEST_REQUEST_CHARGE_CAP: u128 = 100;
pub const TEST_POLICY_CHARGE_CAP: u128 = 500;
pub const TEST_CONTRACT_ADDRESS: Felt252 = Felt252([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xca,
    0xfe,
]);
pub const TEST_SECRET: Felt252 = Felt252([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x12,
    0x34,
]);
pub const TEST_NOTE_ID: u32 = 0;
pub const TEST_DEPOSIT_AMOUNT: u128 = 1_000;
pub const TEST_EXPIRY_TS: u64 = 4_102_444_800;
const TEST_SERVER_EPOCH: u32 = 7;
const TEST_SIGNER_HEIGHT: usize = 4;
const TEST_RESPONSE_CHARGE: u128 = 1;

pub struct DepositFixture {
    pub secret_s: Felt252,
    pub note_id: u32,
    pub deposit_amount: u128,
    pub expiry_ts: u64,
    pub active_root: Felt252,
    pub merkle_siblings: [Felt252; MERKLE_DEPTH],
}

pub struct RequestArtifacts {
    pub api_request: ApiRequest,
    pub journal: PendingRequestJournal,
    pub public_inputs: RequestPublicInputs,
}

pub struct TestServer {
    pub base_url: String,
    _state_dir: TempDir,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        self.task.abort();
    }
}

struct MockApiState {
    current_root: Felt252,
    state_signer: XmssKeypair,
    clear_signer: XmssKeypair,
    responses_by_client_id: Mutex<HashMap<String, RequestResponse>>,
    responses_by_nullifier: Mutex<HashMap<Felt252, RequestResponse>>,
    clearance_reserved: Mutex<HashSet<Felt252>>,
}

impl MockApiState {
    fn new(current_root: Felt252) -> Self {
        Self {
            current_root,
            state_signer: XmssKeypair::generate_with_height(
                &FieldElement::from(101u64),
                TEST_SIGNER_HEIGHT,
            ),
            clear_signer: XmssKeypair::generate_with_height(
                &FieldElement::from(202u64),
                TEST_SIGNER_HEIGHT,
            ),
            responses_by_client_id: Mutex::new(HashMap::new()),
            responses_by_nullifier: Mutex::new(HashMap::new()),
            clearance_reserved: Mutex::new(HashSet::new()),
        }
    }

    async fn process_request(
        &self,
        api_request: ApiRequest,
    ) -> Result<RequestResponse, ErrorResponse> {
        if let Some(existing) = self
            .responses_by_client_id
            .lock()
            .await
            .get(&api_request.client_request_id)
            .cloned()
        {
            return Ok(existing);
        }

        if api_request.public_inputs.active_root != self.current_root {
            return Err(error_body(
                &api_request.client_request_id,
                "STALE_ROOT",
                format!("stale root: latest is {}", self.current_root),
                Some(self.current_root),
            ));
        }

        if self
            .responses_by_nullifier
            .lock()
            .await
            .contains_key(&api_request.public_inputs.request_nullifier)
        {
            return Err(error_body(
                &api_request.client_request_id,
                "REPLAY",
                "replayed nullifier".to_string(),
                None,
            ));
        }

        let proof_bytes = base64::engine::general_purpose::STANDARD
            .decode(api_request.proof.proof.as_bytes())
            .map_err(|err| {
                error_body(
                    &api_request.client_request_id,
                    "INVALID_PROOF",
                    format!("invalid base64 proof: {err}"),
                    None,
                )
            })?;
        verify_request_proof(&proof_bytes, &api_request.public_inputs).map_err(|err| {
            error_body(
                &api_request.client_request_id,
                "INVALID_PROOF",
                err.to_string(),
                None,
            )
        })?;

        let response = self.build_request_response(&api_request)?;
        self.responses_by_client_id
            .lock()
            .await
            .insert(api_request.client_request_id.clone(), response.clone());
        self.responses_by_nullifier.lock().await.insert(
            api_request.public_inputs.request_nullifier,
            response.clone(),
        );

        Ok(response)
    }

    fn build_request_response(
        &self,
        api_request: &ApiRequest,
    ) -> Result<RequestResponse, ErrorResponse> {
        let public_inputs = &api_request.public_inputs;
        let predicted_leaf_index = self.state_signer.next_index();
        let blind_delta_srv = compute_blind_delta(
            &server_rng2(&public_inputs.request_nullifier),
            &public_inputs.request_nullifier,
            predicted_leaf_index,
        );
        let blind_delta_field = felt_to_field(&blind_delta_srv);
        let anon_commitment = reconstruct_affine_point(
            &public_inputs.anon_commitment_x,
            &public_inputs.anon_commitment_y,
        );
        let next_commitment = PedersenCommitment::server_update(
            &anon_commitment,
            TEST_RESPONSE_CHARGE,
            &blind_delta_field,
        );
        let (next_cx_field, next_cy_field) = next_commitment.to_affine();
        let next_cx = field_to_felt(&next_cx_field);
        let next_cy = field_to_felt(&next_cy_field);
        let next_anchor = compute_next_anchor(
            &server_rng(&public_inputs.request_nullifier),
            &public_inputs.request_nullifier,
            &next_cx,
            &next_cy,
            predicted_leaf_index,
        );
        let state_message = compute_state_message(
            TEST_PROTOCOL_VERSION,
            TEST_CHAIN_ID,
            &TEST_CONTRACT_ADDRESS,
            &next_cx,
            &next_cy,
            &next_anchor,
        );
        let (mut next_state_sig, actual_leaf_index) =
            self.state_signer.sign(&state_message).ok_or_else(|| {
                error_body(
                    &api_request.client_request_id,
                    "CAPACITY_EXHAUSTED",
                    "capacity exhausted".to_string(),
                    None,
                )
            })?;
        if actual_leaf_index != predicted_leaf_index {
            return Err(error_body(
                &api_request.client_request_id,
                "INTERNAL",
                "signer leaf index changed unexpectedly".to_string(),
                None,
            ));
        }
        next_state_sig.epoch = TEST_SERVER_EPOCH;

        Ok(RequestResponse {
            status: "ok".to_string(),
            client_request_id: api_request.client_request_id.clone(),
            request_nullifier: public_inputs.request_nullifier,
            response_code: 200,
            response_payload: api_request.payload.clone(),
            response_hash: canonical_response_hash(api_request.payload.as_bytes()),
            charge_applied: TEST_RESPONSE_CHARGE,
            next_commitment: CurvePointWire {
                x: next_cx,
                y: next_cy,
            },
            next_anchor,
            blind_delta_srv,
            next_state_sig_epoch: TEST_SERVER_EPOCH,
            next_state_sig_root: self.state_signer.root_felt(),
            next_state_sig,
            policy_reason_code: None,
            policy_evidence_hash: None,
        })
    }

    async fn process_clearance(
        &self,
        request: ClearanceRequest,
    ) -> Result<ClearanceResponse, ErrorResponse> {
        if self
            .clearance_reserved
            .lock()
            .await
            .contains(&request.withdrawal_nullifier)
        {
            return Err(error_body(
                &request.withdrawal_nullifier.to_hex(),
                "NULLIFIER_USED",
                "nullifier already used".to_string(),
                None,
            ));
        }

        let clear_message = compute_clearance_message(
            TEST_PROTOCOL_VERSION,
            TEST_CHAIN_ID,
            &TEST_CONTRACT_ADDRESS,
            &request.withdrawal_nullifier,
        );
        let (mut clear_sig, _) = self.clear_signer.sign(&clear_message).ok_or_else(|| {
            error_body(
                &request.withdrawal_nullifier.to_hex(),
                "CAPACITY_EXHAUSTED",
                "capacity exhausted".to_string(),
                None,
            )
        })?;
        clear_sig.epoch = TEST_SERVER_EPOCH;

        self.clearance_reserved
            .lock()
            .await
            .insert(request.withdrawal_nullifier);

        Ok(ClearanceResponse {
            status: "ok".to_string(),
            withdrawal_nullifier: request.withdrawal_nullifier,
            clear_sig_epoch: TEST_SERVER_EPOCH,
            clear_sig_root: self.clear_signer.root_felt(),
            clear_sig,
        })
    }
}

pub fn deposit_fixture() -> DepositFixture {
    let commitment = compute_registration_commitment(&TEST_SECRET);
    let leaf = compute_note_leaf(
        TEST_NOTE_ID,
        &commitment,
        TEST_DEPOSIT_AMOUNT,
        TEST_EXPIRY_TS,
    );
    let mut tree = MerkleTree::new();
    tree.insert(leaf);

    DepositFixture {
        secret_s: TEST_SECRET,
        note_id: TEST_NOTE_ID,
        deposit_amount: TEST_DEPOSIT_AMOUNT,
        expiry_ts: TEST_EXPIRY_TS,
        active_root: tree.root(),
        merkle_siblings: tree.get_siblings(TEST_NOTE_ID),
    }
}

pub fn wallet_config(server_url: &str, state_dir: &Path) -> ClientConfig {
    ClientConfig {
        protocol_version: TEST_PROTOCOL_VERSION,
        chain_id: TEST_CHAIN_ID,
        contract_address: TEST_CONTRACT_ADDRESS,
        request_charge_cap: TEST_REQUEST_CHARGE_CAP,
        policy_charge_cap: TEST_POLICY_CHARGE_CAP,
        policy_enabled: false,
        server_url: server_url.to_string(),
        state_dir: state_dir.display().to_string(),
        proof_mode: ClientProofMode::DevWitnessEnvelope,
        trusted_epoch_roots: test_epoch_roots(),
    }
}

/// Trusted signing roots published by the mock server.
///
/// The mock server's XMSS signers are seeded deterministically (see
/// [`MockApiState::new`]), so their roots are reproducible and can be wired
/// into the client's trusted epoch registry without round-tripping the server.
pub fn test_epoch_roots() -> Vec<EpochRoots> {
    let state_signer =
        XmssKeypair::generate_with_height(&FieldElement::from(101u64), TEST_SIGNER_HEIGHT);
    let clear_signer =
        XmssKeypair::generate_with_height(&FieldElement::from(202u64), TEST_SIGNER_HEIGHT);
    vec![EpochRoots {
        epoch: TEST_SERVER_EPOCH,
        state_root: state_signer.root_felt(),
        clear_root: clear_signer.root_felt(),
    }]
}

pub fn journal_path(state_dir: &Path) -> PathBuf {
    state_dir.join("pending_journal.json")
}

pub fn state_path(state_dir: &Path) -> PathBuf {
    state_dir.join("note_state.json")
}

pub fn mock_router(initial_root: Felt252) -> Router {
    let state = Arc::new(MockApiState::new(initial_root));

    Router::new()
        .route("/v1/requests", post(handle_request))
        .route("/v1/withdraw/clearance", post(handle_clearance))
        .route(
            "/v1/requests/{client_request_id}",
            get(handle_recovery_by_id),
        )
        .route(
            "/v1/nullifiers/{nullifier}",
            get(handle_recovery_by_nullifier),
        )
        .with_state(state)
}

pub async fn spawn_mock_server(initial_root: Felt252) -> TestServer {
    let state_dir = TempDir::new().expect("server temp dir");
    let router = mock_router(initial_root);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test listener");
    let local_addr = listener.local_addr().expect("listener addr");
    let base_url = format!("http://{}", local_addr);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    let task = tokio::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(err) = server.await {
            panic!("test server failed: {err}");
        }
    });

    TestServer {
        base_url,
        _state_dir: state_dir,
        shutdown_tx: Some(shutdown_tx),
        task,
    }
}

pub fn parse_blinding(hex_value: &str) -> FieldElement {
    let trimmed = hex_value
        .strip_prefix("0x")
        .or_else(|| hex_value.strip_prefix("0X"))
        .unwrap_or(hex_value);
    let padded = format!("{trimmed:0>64}");
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(padded, &mut bytes).expect("valid blinding hex");
    FieldElement::from_bytes_be(&bytes)
}

pub fn build_request_artifacts(
    note_state: &NoteState,
    active_root: Felt252,
    merkle_siblings: [Felt252; MERKLE_DEPTH],
    payload: &str,
    payload_hash: Felt252,
    client_request_id: &str,
    user_rerandomization: FieldElement,
) -> RequestArtifacts {
    let current_blinding = parse_blinding(&note_state.balance_blinding);
    let (state_sig_epoch, state_sig_root) = if note_state.is_genesis {
        (0, Felt252::ZERO)
    } else {
        (
            note_state.state_sig_epoch.expect("state sig epoch"),
            note_state.state_sig_root.expect("state sig root"),
        )
    };

    let proof_builder = RequestProofBuilder::new(
        note_state.secret_s,
        note_state.note_id,
        note_state.deposit_amount,
        note_state.expiry_ts,
        merkle_siblings,
        note_state.current_balance,
        current_blinding,
        user_rerandomization,
        note_state.current_anchor,
        note_state.is_genesis,
        state_sig_epoch,
        state_sig_root,
        active_root,
        note_state.protocol_version,
        note_state.chain_id,
        note_state.contract_address,
        note_state.solvency_bound(false, TEST_REQUEST_CHARGE_CAP, TEST_POLICY_CHARGE_CAP),
    );
    let public_inputs = proof_builder
        .build_public_inputs()
        .expect("request public inputs");
    let proof_bytes = proof_builder
        .generate_proof(note_state.state_sig.as_ref())
        .expect("request proof");

    RequestArtifacts {
        api_request: ApiRequest {
            client_request_id: client_request_id.to_string(),
            payload: payload.to_string(),
            payload_hash,
            public_inputs: public_inputs.clone(),
            proof: ProofArtifactWire {
                backend: ProofBackendWire::StwoCairo,
                public_output_hash: public_inputs.public_output_hash(),
                proof: base64::engine::general_purpose::STANDARD.encode(proof_bytes),
            },
        },
        journal: PendingRequestJournal {
            exists: true,
            client_request_id: client_request_id.to_string(),
            nullifier: public_inputs.request_nullifier,
            payload_hash,
            user_rerandomization: field_to_felt(&user_rerandomization),
            created_at_ms: 1,
        },
        public_inputs,
    }
}

fn server_rng(nullifier: &Felt252) -> Felt252 {
    poseidon_hash(&DOMAIN_ANCHOR, nullifier, &Felt252::from_u64(1))
}

fn server_rng2(nullifier: &Felt252) -> Felt252 {
    poseidon_hash(&DOMAIN_BLIND, nullifier, &Felt252::from_u64(2))
}

fn reconstruct_affine_point(x: &Felt252, y: &Felt252) -> ProjectivePoint {
    ProjectivePoint::from_affine(felt_to_field(x), felt_to_field(y)).expect("valid affine point")
}

fn error_body(
    client_request_id: &str,
    error_code: &str,
    error_message: String,
    latest_root: Option<Felt252>,
) -> ErrorResponse {
    ErrorResponse {
        status: "error".to_string(),
        client_request_id: client_request_id.to_string(),
        error_code: error_code.to_string(),
        error_message,
        retriable: matches!(error_code, "STALE_ROOT" | "INTERNAL"),
        latest_root,
        server_time_ms: Some(now_ms()),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn handle_request(
    State(state): State<Arc<MockApiState>>,
    Json(api_request): Json<ApiRequest>,
) -> Result<Json<RequestResponse>, (StatusCode, Json<ErrorResponse>)> {
    state
        .process_request(api_request)
        .await
        .map(Json)
        .map_err(status_from_error)
}

async fn handle_clearance(
    State(state): State<Arc<MockApiState>>,
    Json(request): Json<ClearanceRequest>,
) -> Result<Json<ClearanceResponse>, (StatusCode, Json<ErrorResponse>)> {
    state
        .process_clearance(request)
        .await
        .map(Json)
        .map_err(status_from_error)
}

async fn handle_recovery_by_id(
    State(state): State<Arc<MockApiState>>,
    AxumPath(client_request_id): AxumPath<String>,
) -> Json<RecoveryResponse> {
    let maybe = state
        .responses_by_client_id
        .lock()
        .await
        .get(&client_request_id)
        .cloned();

    Json(match maybe {
        Some(request_response) => RecoveryResponse {
            status: "ok".to_string(),
            nullifier_status: "finalized".to_string(),
            request_response: Some(request_response),
        },
        None => RecoveryResponse {
            status: "not_found".to_string(),
            nullifier_status: "unknown".to_string(),
            request_response: None,
        },
    })
}

async fn handle_recovery_by_nullifier(
    State(state): State<Arc<MockApiState>>,
    AxumPath(nullifier): AxumPath<String>,
) -> Json<RecoveryResponse> {
    let nullifier = match Felt252::from_hex(&nullifier) {
        Ok(nullifier) => nullifier,
        Err(_) => {
            return Json(RecoveryResponse {
                status: "not_found".to_string(),
                nullifier_status: "unknown".to_string(),
                request_response: None,
            });
        }
    };
    let maybe = state
        .responses_by_nullifier
        .lock()
        .await
        .get(&nullifier)
        .cloned();

    Json(match maybe {
        Some(request_response) => RecoveryResponse {
            status: "ok".to_string(),
            nullifier_status: "finalized".to_string(),
            request_response: Some(request_response),
        },
        None => RecoveryResponse {
            status: "not_found".to_string(),
            nullifier_status: "unknown".to_string(),
            request_response: None,
        },
    })
}

fn status_from_error(error: ErrorResponse) -> (StatusCode, Json<ErrorResponse>) {
    let status = match error.error_code.as_str() {
        "STALE_ROOT" | "REPLAY" | "NULLIFIER_USED" => StatusCode::CONFLICT,
        "CAPACITY_EXHAUSTED" => StatusCode::SERVICE_UNAVAILABLE,
        "INTERNAL" => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    };
    (status, Json(error))
}
