//! Core client daemon service.
//!
//! [`AuthService`] is the central handle behind every clientd HTTP route. It
//! owns the wallet lifecycle — deposit preparation/confirmation, request
//! execution, status reporting, crash recovery, and withdrawal-proof
//! generation — and talks to the indexer for tree state and to serverd for
//! request processing.
//!
//! All wallet access is serialized by an in-process mutex and guarded by an
//! exclusive on-disk lock file (`.wallet.lock`), so concurrent requests and a
//! second daemon instance pointed at the same state directory cannot corrupt
//! the persisted note state. Blocking wallet/proof work runs on a blocking
//! task so the async runtime stays responsive.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use fs2::FileExt;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zkapi_client::config::{ClientConfig, ClientProofMode};
use zkapi_client::wallet::Wallet;
use zkapi_core::leaf::{compute_note_leaf, compute_registration_commitment};
use zkapi_core::nullifier::compute_nullifier;
use zkapi_types::wire::RequestResponse;
use zkapi_types::{EpochRoots, Felt252, WithdrawalPublicInputs};

fn compute_payload_hash(payload: impl AsRef<[u8]>) -> Felt252 {
    // Must match the protocol's canonical request-payload binding; the wallet
    // re-derives and rejects on mismatch (`request_flow`), and the value feeds
    // the request public inputs.
    zkapi_types::canonical_payload_hash(payload.as_ref())
}

use crate::config::{AuthConfig, ModelDescriptor};
use crate::error::AuthError;
use crate::indexer::IndexerClient;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CoreRequest {
    #[serde(default = "default_method")]
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default = "default_body")]
    pub body: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CoreResponse {
    pub client_request_id: String,
    pub response_code: u16,
    pub raw_payload: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    pub charge_applied: u128,
    pub next_anchor: Felt252,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_balance: Option<u128>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteStatus {
    pub note_id: u32,
    pub deposit_amount: u128,
    pub current_balance: u128,
    pub expiry_ts: u64,
    pub is_genesis: bool,
    pub current_anchor: Felt252,
    pub current_commitment_x: Felt252,
    pub current_commitment_y: Felt252,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WalletStatus {
    pub has_note: bool,
    pub pending_request: bool,
    pub funding_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<NoteStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FundingConfig {
    pub contract_address: Felt252,
    pub chain_id: u64,
    pub indexer_url: String,
    pub protocol_server_url: String,
    pub models: Vec<ModelDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demo_rpc_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demo_billing_token_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demo_private_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demo_note_ttl_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DemoOverview {
    pub wallet: WalletStatus,
    pub funding: FundingConfig,
    pub indexer: IndexerSnapshot,
    pub server: ServerSnapshot,
    pub runtime_proof_backend: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IndexerSnapshot {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<Felt252>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_note_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerSnapshot {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<ServerHealthSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attestation: Option<ServerAttestationSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerHealthSnapshot {
    pub status: String,
    pub protocol_version: u16,
    pub chain_id: u64,
    pub contract_address: Felt252,
    pub current_root: Felt252,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexer_url: Option<String>,
    pub policy_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerAttestationSnapshot {
    pub status: String,
    pub protocol_version: u16,
    pub chain_id: u64,
    pub contract_address: Felt252,
    pub current_root: Felt252,
    pub state_sig_epoch: u32,
    pub clear_sig_epoch: u32,
    pub state_sig_root: Felt252,
    pub clear_sig_root: Felt252,
    pub state_signatures_remaining: u32,
    pub clear_signatures_remaining: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequestPreview {
    pub request: CoreRequest,
    pub payload: String,
    pub payload_hash: Felt252,
    pub registration_commitment: Felt252,
    pub note_leaf: Felt252,
    pub request_nullifier: Felt252,
    pub active_root: Felt252,
    pub merkle_siblings: Vec<Felt252>,
    pub solvency_bound: u128,
    pub wallet_note: NoteStatus,
    pub state_sig_epoch: u32,
    pub state_sig_root: Felt252,
    pub runtime_proof_backend: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProtocolResponseTrace {
    pub client_request_id: String,
    pub request_nullifier: Felt252,
    pub response_code: u16,
    pub response_hash: Felt252,
    pub charge_applied: u128,
    pub next_commitment_x: Felt252,
    pub next_commitment_y: Felt252,
    pub next_anchor: Felt252,
    pub blind_delta_srv: Felt252,
    pub next_state_sig_epoch: u32,
    pub next_state_sig_root: Felt252,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_reason_code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_evidence_hash: Option<Felt252>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequestDemoResult {
    pub preview: RequestPreview,
    pub response: CoreResponse,
    pub protocol_response: ProtocolResponseTrace,
    pub wallet: WalletStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DepositPlan {
    pub amount: u128,
    pub secret: Felt252,
    pub commitment: Felt252,
    pub next_note_id: u32,
    pub active_root: Felt252,
    pub zero_path: Vec<Felt252>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConfirmDepositRequest {
    pub secret: Felt252,
    pub note_id: u32,
    pub amount: u128,
    pub expiry_ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecoverResult {
    pub recovered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<CoreResponse>,
    pub wallet: WalletStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WithdrawalMode {
    Mutual,
    Escape,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WithdrawalPlan {
    pub mode: WithdrawalMode,
    pub public_inputs: WithdrawalPublicInputs,
    pub proof_base64: String,
}

#[derive(Debug)]
pub struct AuthService {
    config: AuthConfig,
    wallet_mutex: Arc<Mutex<()>>,
    indexer: IndexerClient,
}

impl AuthService {
    pub fn new(config: AuthConfig) -> Result<Arc<Self>, AuthError> {
        std::fs::create_dir_all(&config.state_dir)
            .map_err(|err| AuthError::Wallet(err.to_string()))?;
        Ok(Arc::new(Self {
            indexer: IndexerClient::new(config.indexer_url.clone()),
            config,
            wallet_mutex: Arc::new(Mutex::new(())),
        }))
    }

    pub fn default_model(&self) -> &str {
        self.config
            .models
            .first()
            .map(|model| model.id.as_str())
            .unwrap_or("zkapi-echo")
    }

    pub fn models(&self) -> &[ModelDescriptor] {
        &self.config.models
    }

    pub async fn status(&self) -> Result<WalletStatus, AuthError> {
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let wallet = load_wallet(&config, Vec::new())?;
            Ok(wallet_status(&wallet))
        })
        .await
    }

    pub async fn prepare_deposit(&self, amount: u128) -> Result<DepositPlan, AuthError> {
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        let indexer = self.indexer.clone();
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let wallet = load_wallet(&config, Vec::new())?;
            if wallet.state().is_some() {
                return Err(AuthError::InvalidInput(
                    "wallet already has an active note".to_string(),
                ));
            }

            let runtime = current_thread_runtime()?;
            runtime.block_on(async move {
                let next_note_id = indexer.next_note_id().await?;
                let active_root = indexer.root().await?;
                let zero_path = indexer.zero_path(next_note_id).await?;
                let (secret, commitment) = wallet.generate_deposit_params();

                Ok(DepositPlan {
                    amount,
                    secret,
                    commitment,
                    next_note_id,
                    active_root,
                    zero_path,
                })
            })
        })
        .await
    }

    pub async fn confirm_deposit(
        &self,
        request: ConfirmDepositRequest,
    ) -> Result<WalletStatus, AuthError> {
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let mut wallet = load_wallet(&config, Vec::new())?;
            wallet.confirm_deposit(
                request.secret,
                request.note_id,
                request.amount,
                request.expiry_ts,
            )?;
            Ok(wallet_status(&wallet))
        })
        .await
    }

    pub async fn recover(&self) -> Result<RecoverResult, AuthError> {
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        let trusted_roots = self.fetch_trusted_roots().await;
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let mut wallet = load_wallet(&config, trusted_roots)?;
            let runtime = current_thread_runtime()?;
            let recovered = runtime.block_on(wallet.recover())?;
            let request = recovered.as_ref().map(|response| {
                core_response(response, wallet.state().map(|state| state.current_balance))
            });
            Ok(RecoverResult {
                recovered: recovered.is_some(),
                request,
                wallet: wallet_status(&wallet),
            })
        })
        .await
    }

    pub fn funding_config(&self) -> FundingConfig {
        FundingConfig {
            contract_address: self.config.contract_address,
            chain_id: self.config.chain_id,
            indexer_url: self.config.indexer_url.clone(),
            protocol_server_url: self.config.protocol_server_url.clone(),
            models: self.config.models.clone(),
            demo_rpc_url: self.config.demo_rpc_url.clone(),
            demo_billing_token_address: self.config.demo_billing_token_address.clone(),
            demo_private_key: self.config.demo_private_key.clone(),
            demo_note_ttl_seconds: self.config.demo_note_ttl_seconds,
        }
    }

    pub async fn execute_request(&self, request: CoreRequest) -> Result<CoreResponse, AuthError> {
        Ok(self.execute_request_demo(request).await?.response)
    }

    pub async fn demo_overview(&self) -> Result<DemoOverview, AuthError> {
        let wallet = self.status().await?;
        let funding = self.funding_config();
        let indexer = self.fetch_indexer_snapshot().await;
        let server = self.fetch_server_snapshot().await;

        Ok(DemoOverview {
            wallet,
            funding,
            indexer,
            server,
            runtime_proof_backend: "mock_envelope".to_string(),
        })
    }

    pub async fn preview_request(&self, request: CoreRequest) -> Result<RequestPreview, AuthError> {
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        let indexer = self.indexer.clone();
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let wallet = load_wallet(&config, Vec::new())?;
            let runtime = current_thread_runtime()?;
            runtime.block_on(async move {
                build_request_preview(&config, &indexer, &wallet, request).await
            })
        })
        .await
    }

    pub async fn execute_request_demo(
        &self,
        request: CoreRequest,
    ) -> Result<RequestDemoResult, AuthError> {
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        let indexer = self.indexer.clone();
        let trusted_roots = self.fetch_trusted_roots().await;
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let mut wallet = load_wallet(&config, trusted_roots)?;
            let payload = serde_json::to_string(&request)
                .map_err(|err| AuthError::Serialization(err.to_string()))?;
            let payload_hash = hash_payload(&payload);
            let runtime = current_thread_runtime()?;

            runtime.block_on(async move {
                if wallet.has_pending_request() {
                    let _ = wallet.recover().await?;
                }

                let note_id = wallet.state().ok_or(AuthError::NoActiveNote)?.note_id;
                for attempt in 0..2 {
                    let preview =
                        build_request_preview(&config, &indexer, &wallet, request.clone()).await?;
                    match wallet
                        .request_flow(
                            &payload,
                            payload_hash,
                            preview.active_root,
                            preview.merkle_siblings.clone(),
                        )
                        .await
                    {
                        Ok(response) => {
                            let wallet_status = wallet_status(&wallet);
                            let core = core_response(
                                &response,
                                wallet.state().map(|state| state.current_balance),
                            );
                            return Ok(RequestDemoResult {
                                preview,
                                response: core,
                                protocol_response: protocol_response_trace(&response),
                                wallet: wallet_status,
                            });
                        }
                        Err(zkapi_client::error::ClientError::StaleRoot) if attempt == 0 => {
                            let _ = note_id;
                            continue;
                        }
                        Err(err) => return Err(err.into()),
                    }
                }

                Err(AuthError::Wallet(
                    "request failed after retrying stale root".to_string(),
                ))
            })
        })
        .await
    }

    pub async fn create_withdrawal(
        &self,
        mode: WithdrawalMode,
        destination: [u8; 20],
    ) -> Result<WithdrawalPlan, AuthError> {
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        let indexer = self.indexer.clone();
        let trusted_roots = self.fetch_trusted_roots().await;
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let mut wallet = load_wallet(&config, trusted_roots)?;
            let runtime = current_thread_runtime()?;

            runtime.block_on(async move {
                let note_id = wallet.state().ok_or(AuthError::NoActiveNote)?.note_id;
                let root = indexer.root().await?;
                let siblings = indexer.note_path(note_id).await?;
                let (public_inputs, proof) = match mode {
                    WithdrawalMode::Mutual => {
                        wallet
                            .withdrawal_mutual_close(destination, root, siblings)
                            .await?
                    }
                    WithdrawalMode::Escape => {
                        wallet.withdrawal_escape_hatch(destination, root, siblings)?
                    }
                };

                Ok(WithdrawalPlan {
                    mode,
                    public_inputs,
                    // `proof.proof` already carries the base64-encoded opaque
                    // proof blob that the on-chain proof adapter consumes.
                    proof_base64: proof.proof,
                })
            })
        })
        .await
    }

    pub fn funding_index_html(&self) -> &'static str {
        include_str!("../../../funding-page/index.html")
    }

    pub fn funding_styles_css(&self) -> &'static str {
        include_str!("../../../funding-page/styles.css")
    }

    pub fn funding_app_js(&self) -> &'static str {
        include_str!("../../../funding-page/app.js")
    }

    async fn fetch_indexer_snapshot(&self) -> IndexerSnapshot {
        match tokio::try_join!(self.indexer.root(), self.indexer.next_note_id()) {
            Ok((root, next_note_id)) => IndexerSnapshot {
                available: true,
                root: Some(root),
                next_note_id: Some(next_note_id),
                error: None,
            },
            Err(err) => IndexerSnapshot {
                available: false,
                root: None,
                next_note_id: None,
                error: Some(err.to_string()),
            },
        }
    }

    async fn fetch_server_snapshot(&self) -> ServerSnapshot {
        let health_url = format!(
            "{}/health",
            self.config.protocol_server_url.trim_end_matches('/')
        );
        let attestation_url = format!(
            "{}/v1/attestation",
            self.config.protocol_server_url.trim_end_matches('/')
        );

        match tokio::try_join!(
            fetch_json::<ServerHealthSnapshot>(&health_url),
            fetch_json::<ServerAttestationSnapshot>(&attestation_url),
        ) {
            Ok((health, attestation)) => ServerSnapshot {
                available: true,
                health: Some(health),
                attestation: Some(attestation),
                error: None,
            },
            Err(err) => ServerSnapshot {
                available: false,
                health: None,
                attestation: None,
                error: Some(err),
            },
        }
    }

    /// Fetch the server's published signing roots so the wallet can validate
    /// state/clearance signatures against a trusted epoch registry.
    ///
    /// On failure we return an empty registry; genesis (registration) requests
    /// do not need it, and any later verification then fails closed with a
    /// clear "epoch is not trusted" error rather than trusting a forged root.
    async fn fetch_trusted_roots(&self) -> Vec<EpochRoots> {
        let attestation_url = format!(
            "{}/v1/attestation",
            self.config.protocol_server_url.trim_end_matches('/')
        );
        match fetch_json::<ServerAttestationSnapshot>(&attestation_url).await {
            Ok(att) => epoch_roots_from_attestation(&att),
            Err(_) => Vec::new(),
        }
    }
}

impl CoreRequest {
    pub fn post_json(path: &str, body: Value) -> Self {
        Self {
            method: "POST".to_string(),
            path: path.to_string(),
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body,
        }
    }
}

fn core_response(response: &RequestResponse, remaining_balance: Option<u128>) -> CoreResponse {
    CoreResponse {
        client_request_id: response.client_request_id.clone(),
        response_code: response.response_code,
        raw_payload: response.response_payload.clone(),
        payload: serde_json::from_str(&response.response_payload).ok(),
        charge_applied: response.charge_applied,
        next_anchor: response.next_anchor,
        remaining_balance,
    }
}

fn protocol_response_trace(response: &RequestResponse) -> ProtocolResponseTrace {
    ProtocolResponseTrace {
        client_request_id: response.client_request_id.clone(),
        request_nullifier: response.request_nullifier,
        response_code: response.response_code,
        response_hash: response.response_hash,
        charge_applied: response.charge_applied,
        next_commitment_x: response.next_commitment.x,
        next_commitment_y: response.next_commitment.y,
        next_anchor: response.next_anchor,
        blind_delta_srv: response.blind_delta_srv,
        next_state_sig_epoch: response.next_state_sig_epoch,
        next_state_sig_root: response.next_state_sig_root,
        policy_reason_code: response.policy_reason_code,
        policy_evidence_hash: response.policy_evidence_hash,
    }
}

fn wallet_status(wallet: &Wallet) -> WalletStatus {
    WalletStatus {
        has_note: wallet.state().is_some(),
        pending_request: wallet.has_pending_request(),
        funding_url: "/funding".to_string(),
        note: wallet.state().map(|state| NoteStatus {
            note_id: state.note_id,
            deposit_amount: state.deposit_amount,
            current_balance: state.current_balance,
            expiry_ts: state.expiry_ts,
            is_genesis: state.is_genesis,
            current_anchor: state.current_anchor,
            current_commitment_x: state.current_commitment_x,
            current_commitment_y: state.current_commitment_y,
        }),
    }
}

fn hash_payload(payload: &str) -> Felt252 {
    compute_payload_hash(payload.as_bytes())
}

async fn build_request_preview(
    config: &AuthConfig,
    indexer: &IndexerClient,
    wallet: &Wallet,
    request: CoreRequest,
) -> Result<RequestPreview, AuthError> {
    let payload =
        serde_json::to_string(&request).map_err(|err| AuthError::Serialization(err.to_string()))?;
    let payload_hash = hash_payload(&payload);
    let state = wallet.state().ok_or(AuthError::NoActiveNote)?;
    let active_root = indexer.root().await?;
    let merkle_siblings = indexer.note_path(state.note_id).await?;
    let registration_commitment = compute_registration_commitment(&state.secret_s);
    let note_leaf = compute_note_leaf(
        state.note_id,
        &registration_commitment,
        state.deposit_amount,
        state.expiry_ts,
    );
    let request_nullifier = compute_nullifier(&state.secret_s, &state.current_anchor);
    let solvency_bound = state.solvency_bound(
        config.policy_enabled,
        config.request_charge_cap,
        config.policy_charge_cap,
    );
    let wallet_note = NoteStatus {
        note_id: state.note_id,
        deposit_amount: state.deposit_amount,
        current_balance: state.current_balance,
        expiry_ts: state.expiry_ts,
        is_genesis: state.is_genesis,
        current_anchor: state.current_anchor,
        current_commitment_x: state.current_commitment_x,
        current_commitment_y: state.current_commitment_y,
    };

    Ok(RequestPreview {
        request,
        payload,
        payload_hash,
        registration_commitment,
        note_leaf,
        request_nullifier,
        active_root,
        merkle_siblings,
        solvency_bound,
        wallet_note,
        state_sig_epoch: state.state_sig_epoch.unwrap_or(0),
        state_sig_root: state.state_sig_root.unwrap_or(Felt252::ZERO),
        runtime_proof_backend: "mock_envelope".to_string(),
    })
}

fn wallet_lock_path(state_dir: &Path) -> PathBuf {
    state_dir.join(".wallet.lock")
}

fn client_config(config: &AuthConfig, trusted_epoch_roots: Vec<EpochRoots>) -> ClientConfig {
    ClientConfig {
        protocol_version: config.protocol_version,
        chain_id: config.chain_id,
        contract_address: config.contract_address,
        request_charge_cap: config.request_charge_cap,
        policy_charge_cap: config.policy_charge_cap,
        policy_enabled: config.policy_enabled,
        server_url: config.protocol_server_url.clone(),
        state_dir: config.state_dir.to_string_lossy().to_string(),
        // The runtime daemon path uses the development witness envelope; real
        // Stwo-Cairo proving is the production proof mode (see roadmap).
        proof_mode: ClientProofMode::DevWitnessEnvelope,
        trusted_epoch_roots,
    }
}

fn load_wallet(
    config: &AuthConfig,
    trusted_epoch_roots: Vec<EpochRoots>,
) -> Result<Wallet, AuthError> {
    Wallet::new(client_config(config, trusted_epoch_roots)).map_err(Into::into)
}

/// Build the trusted server signing roots from a server attestation snapshot.
///
/// The client now validates every server-returned state/clearance signature
/// root against this registry (the server cannot make the client trust an
/// arbitrary root). A single epoch entry carries both the state and clearance
/// roots; we add a second entry only if the two epochs diverge.
fn epoch_roots_from_attestation(att: &ServerAttestationSnapshot) -> Vec<EpochRoots> {
    let mut roots = vec![EpochRoots {
        epoch: att.state_sig_epoch,
        state_root: att.state_sig_root,
        clear_root: att.clear_sig_root,
    }];
    if att.clear_sig_epoch != att.state_sig_epoch {
        roots.push(EpochRoots {
            epoch: att.clear_sig_epoch,
            state_root: att.state_sig_root,
            clear_root: att.clear_sig_root,
        });
    }
    roots
}

fn acquire_wallet_lock(state_dir: &Path) -> Result<std::fs::File, AuthError> {
    let path = wallet_lock_path(state_dir);
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|err| AuthError::Wallet(err.to_string()))?;
    file.try_lock_exclusive()
        .map_err(|_| AuthError::WalletBusy)?;
    Ok(file)
}

fn current_thread_runtime() -> Result<tokio::runtime::Runtime, AuthError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| AuthError::Wallet(err.to_string()))
}

async fn fetch_json<T>(url: &str) -> Result<T, String>
where
    T: DeserializeOwned,
{
    let response = reqwest::get(url)
        .await
        .map_err(|err| format!("request failed for {url}: {err}"))?;
    let response = response
        .error_for_status()
        .map_err(|err| format!("non-success response from {url}: {err}"))?;
    response
        .json::<T>()
        .await
        .map_err(|err| format!("invalid JSON from {url}: {err}"))
}

async fn spawn_blocking<T>(
    task: impl FnOnce() -> Result<T, AuthError> + Send + 'static,
) -> Result<T, AuthError>
where
    T: Send + 'static,
{
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|err| AuthError::Wallet(err.to_string()))?
}

fn default_method() -> String {
    "POST".to_string()
}

fn default_body() -> Value {
    Value::Object(Default::default())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, RwLock};

    use axum::extract::{Path as AxumPath, State};
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;
    use tokio::net::TcpListener;
    use zkapi_core::leaf::{compute_note_leaf, compute_registration_commitment};
    use zkapi_core::merkle::MerkleTree;
    use zkapi_core::poseidon::felt_to_field;
    use zkapi_serverd::nullifier_store::NullifierStore;
    use zkapi_serverd::processor::RequestProcessor;
    use zkapi_serverd::provider::EchoProvider;
    use zkapi_serverd::routes::create_router;
    use zkapi_serverd::signer::ServerSigner;

    use super::*;

    #[derive(Clone)]
    struct IndexerState {
        tree: Arc<RwLock<MerkleTree>>,
    }

    #[derive(Serialize)]
    struct TreeRootResponse {
        root: Felt252,
    }

    #[derive(Serialize)]
    struct TreePathResponse {
        note_id: u32,
        leaf: Felt252,
        siblings: Vec<Felt252>,
    }

    #[derive(Serialize)]
    struct NextNoteIdResponse {
        next_note_id: u32,
    }

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("zkapi_clientd_tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn spawn_axum(router: Router) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        format!("http://{}", addr)
    }

    fn indexer_router(tree: Arc<RwLock<MerkleTree>>) -> Router {
        async fn root(State(state): State<IndexerState>) -> Json<TreeRootResponse> {
            Json(TreeRootResponse {
                root: state.tree.read().unwrap().root(),
            })
        }

        async fn next_note_id(State(state): State<IndexerState>) -> Json<NextNoteIdResponse> {
            Json(NextNoteIdResponse {
                next_note_id: state.tree.read().unwrap().next_index(),
            })
        }

        async fn path(
            State(state): State<IndexerState>,
            AxumPath(note_id): AxumPath<u32>,
        ) -> Json<TreePathResponse> {
            Json(TreePathResponse {
                note_id,
                leaf: state.tree.read().unwrap().get_leaf(note_id),
                siblings: state.tree.read().unwrap().get_siblings(note_id).to_vec(),
            })
        }

        Router::new()
            .route("/v1/tree/root", get(root))
            .route("/v1/tree/next-note-id", get(next_note_id))
            .route("/v1/tree/notes/{note_id}/path", get(path))
            .route("/v1/tree/notes/{note_id}/zero-path", get(path))
            .with_state(IndexerState { tree })
    }

    async fn protocol_server(root: Felt252, dir: &Path) -> String {
        let store = Arc::new(NullifierStore::new(dir.join("server.db")).unwrap());
        let signer = Arc::new(ServerSigner::with_height(
            felt_to_field(&Felt252::from_u64(1)),
            felt_to_field(&Felt252::from_u64(2)),
            1,
            8,
        ));
        let processor = Arc::new(RequestProcessor::new(
            zkapi_serverd::config::ServerConfig {
                contract_address: Felt252::from_u64(0xdeadbeef),
                chain_id: 1,
                protocol_version: 1,
                request_charge_cap: 100,
                policy_charge_cap: 100,
                initial_root: root,
                ..Default::default()
            },
            store,
            signer,
            Arc::new(EchoProvider::default()),
            root,
        ));
        spawn_axum(create_router(processor)).await
    }

    #[tokio::test]
    async fn prepare_deposit_fetches_indexer_snapshot() {
        let state_dir = test_dir("prepare_deposit");
        let tree = Arc::new(RwLock::new(MerkleTree::new()));
        let indexer_url = spawn_axum(indexer_router(tree)).await;

        let service = AuthService::new(AuthConfig {
            indexer_url,
            state_dir,
            ..Default::default()
        })
        .unwrap();

        let plan = service.prepare_deposit(123).await.unwrap();
        assert_eq!(plan.amount, 123);
        assert_eq!(plan.next_note_id, 0);
        assert_eq!(plan.zero_path.len(), zkapi_types::MERKLE_DEPTH);
        assert!(!plan.secret.is_zero());
        assert!(!plan.commitment.is_zero());
    }

    #[tokio::test]
    async fn preview_request_reports_protocol_inputs() {
        let state_dir = test_dir("preview_request");
        let tree = Arc::new(RwLock::new(MerkleTree::new()));
        let indexer_url = spawn_axum(indexer_router(tree.clone())).await;

        let mut seed_wallet = Wallet::new(ClientConfig {
            protocol_version: 1,
            chain_id: 1,
            contract_address: Felt252::from_u64(0xdeadbeef),
            request_charge_cap: 100,
            policy_charge_cap: 100,
            policy_enabled: false,
            server_url: "http://127.0.0.1:1".to_string(),
            state_dir: state_dir.to_string_lossy().to_string(),
            proof_mode: ClientProofMode::DevWitnessEnvelope,
            trusted_epoch_roots: Vec::new(),
        })
        .unwrap();
        let (secret, commitment) = seed_wallet.generate_deposit_params();
        seed_wallet
            .confirm_deposit(secret, 0, 100, 4_000_000_000)
            .unwrap();

        let leaf = compute_note_leaf(0, &commitment, 100, 4_000_000_000);
        tree.write().unwrap().insert(leaf);

        let service = AuthService::new(AuthConfig {
            indexer_url,
            state_dir,
            request_charge_cap: 100,
            policy_charge_cap: 100,
            contract_address: Felt252::from_u64(0xdeadbeef),
            ..Default::default()
        })
        .unwrap();

        let preview = service
            .preview_request(CoreRequest::post_json(
                "/v1/chat/completions",
                json!({
                    "model": "demo",
                    "messages": [{ "role": "user", "content": "hi" }],
                }),
            ))
            .await
            .unwrap();

        assert_eq!(preview.wallet_note.note_id, 0);
        assert_eq!(preview.wallet_note.current_balance, 100);
        assert_eq!(preview.solvency_bound, 100);
        assert_eq!(preview.merkle_siblings.len(), zkapi_types::MERKLE_DEPTH);
        assert_eq!(preview.state_sig_epoch, 0);
        assert_eq!(preview.state_sig_root, Felt252::ZERO);
        assert_eq!(preview.runtime_proof_backend, "mock_envelope");
        assert!(preview.request.path.contains("/v1/chat/completions"));
        assert!(!preview.payload_hash.is_zero());
        assert!(!preview.registration_commitment.is_zero());
        assert!(!preview.request_nullifier.is_zero());
    }

    #[tokio::test]
    #[ignore = "full proof generation and request roundtrip is expensive"]
    async fn execute_request_round_trips_through_protocol_server() {
        let state_dir = test_dir("round_trip");
        let tree = Arc::new(RwLock::new(MerkleTree::new()));
        let indexer_url = spawn_axum(indexer_router(tree.clone())).await;

        let mut seed_wallet = Wallet::new(ClientConfig {
            protocol_version: 1,
            chain_id: 1,
            contract_address: Felt252::from_u64(0xdeadbeef),
            request_charge_cap: 100,
            policy_charge_cap: 100,
            policy_enabled: false,
            server_url: "http://127.0.0.1:1".to_string(),
            state_dir: state_dir.to_string_lossy().to_string(),
            proof_mode: ClientProofMode::DevWitnessEnvelope,
            trusted_epoch_roots: Vec::new(),
        })
        .unwrap();
        let (secret, commitment) = seed_wallet.generate_deposit_params();
        seed_wallet
            .confirm_deposit(secret, 0, 100, 4_000_000_000)
            .unwrap();

        let leaf = compute_note_leaf(0, &commitment, 100, 4_000_000_000);
        tree.write().unwrap().insert(leaf);
        let root = tree.read().unwrap().root();
        let protocol_server_url = protocol_server(root, &state_dir).await;

        let service = AuthService::new(AuthConfig {
            protocol_server_url,
            indexer_url,
            state_dir: state_dir.clone(),
            request_charge_cap: 100,
            policy_charge_cap: 100,
            contract_address: Felt252::from_u64(0xdeadbeef),
            models: vec![ModelDescriptor::new("demo")],
            ..Default::default()
        })
        .unwrap();

        let response = service
            .execute_request(CoreRequest::post_json(
                "/v1/chat/completions",
                json!({
                    "model": "demo",
                    "messages": [{ "role": "user", "content": "hi" }],
                }),
            ))
            .await
            .unwrap();

        assert_eq!(response.response_code, 200);
        assert_eq!(response.charge_applied, 1);
        assert_eq!(response.remaining_balance, Some(99));
        assert!(response.raw_payload.contains("/v1/chat/completions"));
    }

    #[tokio::test]
    async fn status_fails_when_lockfile_is_held_elsewhere() {
        let state_dir = test_dir("lockfile");
        let lockfile = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(wallet_lock_path(&state_dir))
            .unwrap();
        lockfile.try_lock_exclusive().unwrap();

        let service = AuthService::new(AuthConfig {
            state_dir,
            ..Default::default()
        })
        .unwrap();

        let err = service.status().await.unwrap_err();
        assert!(matches!(err, AuthError::WalletBusy));
    }

    #[test]
    fn payload_hash_is_stable() {
        let hash_a = hash_payload("{\"x\":1}");
        let hash_b = hash_payload("{\"x\":1}");
        assert_eq!(hash_a, hash_b);
        assert_ne!(hash_a, Felt252::ZERO);
    }

    #[test]
    fn registration_commitment_matches_wallet_secret_shape() {
        let secret = Felt252::from_u64(11);
        let commitment = compute_registration_commitment(&secret);
        assert!(!commitment.is_zero());
    }
}
