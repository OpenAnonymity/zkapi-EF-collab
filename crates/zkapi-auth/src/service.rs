use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zkapi_client::config::ClientConfig;
use zkapi_client::wallet::Wallet;
use zkapi_core::compute_payload_hash;
use zkapi_types::wire::RequestResponse;
use zkapi_types::{Felt252, WithdrawalPublicInputs};

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
    pub models: Vec<ModelDescriptor>,
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
            let wallet = load_wallet(&config)?;
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
            let wallet = load_wallet(&config)?;
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
            let mut wallet = load_wallet(&config)?;
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
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let mut wallet = load_wallet(&config)?;
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
            models: self.config.models.clone(),
        }
    }

    pub async fn execute_request(&self, request: CoreRequest) -> Result<CoreResponse, AuthError> {
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        let indexer = self.indexer.clone();
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let mut wallet = load_wallet(&config)?;
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
                    let root = indexer.root().await?;
                    let siblings = indexer.note_path(note_id).await?;
                    match wallet
                        .request_flow(&payload, payload_hash, root, siblings)
                        .await
                    {
                        Ok(response) => {
                            return Ok(core_response(
                                &response,
                                wallet.state().map(|state| state.current_balance),
                            ))
                        }
                        Err(zkapi_client::error::ClientError::StaleRoot) if attempt == 0 => {
                            continue
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
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let mut wallet = load_wallet(&config)?;
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
                    proof_base64: base64::engine::general_purpose::STANDARD.encode(proof),
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

fn wallet_lock_path(state_dir: &Path) -> PathBuf {
    state_dir.join(".wallet.lock")
}

fn client_config(config: &AuthConfig) -> ClientConfig {
    ClientConfig {
        protocol_version: config.protocol_version,
        chain_id: config.chain_id,
        contract_address: config.contract_address,
        request_charge_cap: config.request_charge_cap,
        policy_charge_cap: config.policy_charge_cap,
        policy_enabled: config.policy_enabled,
        server_url: config.protocol_server_url.clone(),
        state_dir: config.state_dir.to_string_lossy().to_string(),
    }
}

fn load_wallet(config: &AuthConfig) -> Result<Wallet, AuthError> {
    Wallet::new(client_config(config)).map_err(Into::into)
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
    use zkapi_server::nullifier_store::NullifierStore;
    use zkapi_server::processor::RequestProcessor;
    use zkapi_server::provider::EchoProvider;
    use zkapi_server::routes::create_router;
    use zkapi_server::signer::ServerSigner;

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
        let dir = std::env::temp_dir().join("zkapi_auth_tests").join(name);
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
            zkapi_server::config::ServerConfig {
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
