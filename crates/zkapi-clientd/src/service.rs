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
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use fs2::FileExt;
use futures_util::stream::{self, BoxStream};
use futures_util::StreamExt;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zkapi_client::config::{ClientConfig, ClientProofMode};
use zkapi_client::wallet::Wallet;
use zkapi_core::v2 as core_v2;
use zkapi_types::wire::{
    ApiRequestV2, ErrorResponse, Groth16ProofWire, OpenRouterLeaseAuthorization,
    OpenRouterLeaseResponse, OpenRouterLeaseStatusResponse, RecoveryResponseV2, RequestResponseV2,
};
use zkapi_types::{EpochRoots, Felt252, WithdrawalPublicInputsV2};

fn compute_payload_hash(payload: impl AsRef<[u8]>) -> Felt252 {
    // Must match the protocol's canonical request-payload binding; the wallet
    // re-derives and rejects on mismatch (`request_flow`), and the value feeds
    // the request public inputs.
    zkapi_types::canonical_payload_hash(payload.as_ref())
}

use crate::config::{AuthConfig, ModelDescriptor, RequestMode};
use crate::error::AuthError;
use crate::indexer::IndexerClient;

const DIRECT_REMOTE_MAX_ATTEMPTS: usize = 3;
const DIRECT_REMOTE_RETRY_BASE_DELAY: Duration = Duration::from_millis(250);
const DIRECT_REMOTE_RETRY_MAX_DELAY: Duration = Duration::from_secs(5);
const DIRECT_LEASE_RETIRE_POLL_INTERVAL: Duration = Duration::from_secs(2);
const DIRECT_LEASE_RETIRE_MAX_WAIT: Duration = Duration::from_secs(45);
include!(concat!(env!("OUT_DIR"), "/embedded_funding_assets.rs"));

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

/// A low-balance note moved out of the active wallet slot.
///
/// `state_dir` remains a complete wallet state directory, so the note can be
/// selected later for withdrawal without keeping it in the daemon's active
/// request path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetiredNote {
    pub note_id: u32,
    pub remaining_balance: u128,
    pub state_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FundingConfig {
    pub contract_address: Felt252,
    pub chain_id: u64,
    pub indexer_url: String,
    pub protocol_server_url: String,
    pub models: Vec<ModelDescriptor>,
    /// Suggested ERC-20 base-unit amount for a fresh note. The browser can
    /// override this, but should present a safe default with request headroom.
    pub suggested_deposit_amount: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demo_rpc_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demo_billing_token_address: Option<String>,
    pub demo_mint_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demo_note_ttl_seconds: Option<u64>,
}

/// Integration credit unit: 1 credit = 1 micro-US-dollar. Mirrors
/// `zkapi_serverd::pricing::CREDITS_PER_USD`; used by the client UI to render
/// USD next to credit amounts when the server doesn't report its own scale.
pub const CREDITS_PER_USD: f64 = 1_000_000.0;

/// Integration configuration surfaced to browser clients: the credit scale,
/// per-request cap, funding parameters, and upstream metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ZkapiConfig {
    pub credits_per_usd: f64,
    pub request_charge_cap: u128,
    pub request_charge_cap_usd: f64,
    pub policy_charge_cap: u128,
    pub policy_enabled: bool,
    pub funding: FundingConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_kind: Option<String>,
    pub direct_openrouter_available: bool,
    pub request_mode: RequestMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_lease: Option<DirectLeaseStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepared_withdrawal: Option<PreparedWithdrawalStatus>,
}

/// Non-secret metadata for the prompt-private key currently held in memory.
/// The API key itself is intentionally never exposed by the local daemon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DirectLeaseStatus {
    pub session_id: String,
    pub client_request_id: String,
    pub expires_at: u64,
    pub settle_after: u64,
}

/// Non-secret metadata for an on-chain withdrawal prepared by the daemon.
/// The full proof stays in memory and is returned idempotently only from the
/// withdrawal endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreparedWithdrawalStatus {
    pub mode: WithdrawalMode,
    pub note_id: u32,
    pub destination: String,
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
    #[serde(default)]
    pub auth_scheme: String,
    #[serde(default)]
    pub request_modes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerAttestationSnapshot {
    pub status: String,
    pub protocol_version: u16,
    pub chain_id: u64,
    pub contract_address: Felt252,
    pub current_root: Felt252,
    pub state_signing_key: zkapi_types::wire::CurvePointWire,
    pub clearance_signing_key: zkapi_types::wire::CurvePointWire,
    #[serde(default)]
    pub auth_scheme: String,
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

#[derive(Clone)]
struct ActiveOpenRouterLease {
    session_id: String,
    client_request_id: String,
    api_key: String,
    openrouter_api_base: String,
    expires_at: u64,
    settle_after: u64,
    verification: Option<OaKeyVerificationEvidence>,
    verified: bool,
    requests_served: u32,
}

/// An upstream response whose body owns the local inference lock.
///
/// The time-bounded OpenRouter lease remains in memory after EOF and can serve
/// later local LLM calls. Consuming or dropping the body only releases the
/// lock that prevents two streams from using the same key concurrently.
pub struct StreamingCoreResponse {
    pub status: reqwest::StatusCode,
    pub content_type: Option<reqwest::header::HeaderValue>,
    pub cache_control: Option<reqwest::header::HeaderValue>,
    pub body: BoxStream<'static, Result<Bytes, io::Error>>,
}

struct DirectOpenRouterStreamFinalizer {
    service: Arc<AuthService>,
    client_request_id: Option<String>,
    request_guard: Option<tokio::sync::OwnedRwLockReadGuard<()>>,
}

impl Drop for DirectOpenRouterStreamFinalizer {
    fn drop(&mut self) {
        let Some(client_request_id) = self.client_request_id.take() else {
            return;
        };
        let service = self.service.clone();
        let request_guard = self.request_guard.take();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::warn!(
                %client_request_id,
                "stream ended outside the async runtime; lease settlement will resume on the next request"
            );
            return;
        };
        runtime.spawn(async move {
            drop(request_guard);
            let _request_guard = service.direct_request_mutex.clone().write_owned().await;
            service
                .finish_direct_openrouter_lease(client_request_id)
                .await;
        });
    }
}

#[derive(Debug, Deserialize)]
struct OpenRouterLeaseExtensions {
    #[serde(default = "default_openrouter_key_source")]
    key_source: String,
    #[serde(default)]
    verification: Option<OaKeyVerificationEvidence>,
}

#[derive(Debug, Clone, Deserialize)]
struct OaKeyVerificationEvidence {
    verifier_url: String,
    station_id: String,
    #[serde(default)]
    station_recently_attested: bool,
    key_valid_till: u64,
    station_signature: String,
    org_signature: String,
}

const MAX_OA_SIGNATURE_ENCODING_LEN: usize = 4_096;
const MAX_OA_EVIDENCE_EXPIRY_SKEW_SECONDS: u64 = 60;

fn validate_oa_key_evidence(
    expires_at: u64,
    evidence: &OaKeyVerificationEvidence,
) -> Result<(), AuthError> {
    if evidence.station_id.trim().is_empty() {
        return Err(AuthError::KeyVerification(
            "OA key evidence omitted the station ID".to_string(),
        ));
    }
    let expiry_skew = evidence.key_valid_till.saturating_sub(expires_at);
    if evidence.key_valid_till < expires_at || expiry_skew > MAX_OA_EVIDENCE_EXPIRY_SKEW_SECONDS {
        return Err(AuthError::KeyVerification(format!(
            "OA key evidence expiry {} does not safely cover lease expiry {expires_at}",
            evidence.key_valid_till
        )));
    }
    for (label, signature) in [
        ("station", evidence.station_signature.as_str()),
        ("org", evidence.org_signature.as_str()),
    ] {
        if signature.is_empty() {
            return Err(AuthError::KeyVerification(format!(
                "OA key evidence omitted the {label} signature"
            )));
        }
        if signature.len() > MAX_OA_SIGNATURE_ENCODING_LEN {
            return Err(AuthError::KeyVerification(format!(
                "OA key evidence {label} signature encoding is oversized"
            )));
        }
    }
    Ok(())
}

fn default_openrouter_key_source() -> String {
    "openrouter".to_string()
}

fn is_secure_or_loopback_url(value: &str) -> bool {
    value.starts_with("https://")
        || value.starts_with("http://127.0.0.1:")
        || value.starts_with("http://localhost:")
}

fn matches_trusted_url(supplied: &str, expected: &str) -> bool {
    let expected = expected.trim_end_matches('/');
    is_secure_or_loopback_url(expected) && supplied.trim_end_matches('/') == expected
}

fn enforce_required_key_source(require_oa: bool, source: &str) -> Result<(), AuthError> {
    if require_oa && source != "oa_org" {
        return Err(AuthError::KeyVerification(
            "client policy requires an OA-org verifier-backed key".to_string(),
        ));
    }
    Ok(())
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
    pub public_inputs: WithdrawalPublicInputsV2,
    /// The note's Merkle sibling path, so the on-chain submitter (cast or the
    /// browser wallet) can call `mutualClose`/escape without a per-slot lookup.
    pub siblings: Vec<Felt252>,
    /// Complete opaque proof artifact, including backend and public-output hash.
    pub proof: Groth16ProofWire,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WithdrawalChainStatus {
    pub note_id: u32,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub challenge_deadline: Option<u64>,
    pub wallet: WalletStatus,
}

pub struct AuthService {
    config: AuthConfig,
    wallet_mutex: Arc<Mutex<()>>,
    indexer: IndexerClient,
    http: reqwest::Client,
    direct_lease: tokio::sync::Mutex<Option<ActiveOpenRouterLease>>,
    direct_request_mutex: Arc<tokio::sync::RwLock<()>>,
    prepared_withdrawal: tokio::sync::Mutex<Option<WithdrawalPlan>>,
}

impl AuthService {
    pub fn new(config: AuthConfig) -> Result<Arc<Self>, AuthError> {
        std::fs::create_dir_all(&config.state_dir)
            .map_err(|err| AuthError::Wallet(err.to_string()))?;
        let prepared_withdrawal = load_prepared_withdrawal(&config.state_dir)?;
        Ok(Arc::new(Self {
            indexer: IndexerClient::new(config.indexer_url.clone()),
            config,
            wallet_mutex: Arc::new(Mutex::new(())),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(180))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| AuthError::Wallet(error.to_string()))?,
            direct_lease: tokio::sync::Mutex::new(None),
            direct_request_mutex: Arc::new(tokio::sync::RwLock::new(())),
            prepared_withdrawal: tokio::sync::Mutex::new(prepared_withdrawal),
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

    /// Preserve a note that cannot safely authorize another maximum-cost
    /// request and clear the active wallet slot for a fresh deposit.
    ///
    /// The balance check and filesystem move happen under the same wallet
    /// locks as request execution. A pending request is never retired because
    /// its eventual response may still advance the note state.
    pub async fn retire_low_balance_note(&self) -> Result<Option<RetiredNote>, AuthError> {
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let wallet = load_wallet(&config, Vec::new())?;
            let Some(state) = wallet.state() else {
                return Ok(None);
            };
            let proof_bound = if config.policy_enabled {
                config.policy_charge_cap
            } else {
                config.request_charge_cap
            };
            if state.current_balance > proof_bound {
                return Ok(None);
            }
            // The wallet normally removes this file after settlement. Treat
            // any surviving journal (including one too damaged to parse) as
            // in-flight state and fail closed instead of separating it from
            // its note.
            if config.state_dir.join("pending_journal.json").exists() {
                return Err(AuthError::PendingRequest);
            }

            let note_id = state.note_id;
            let remaining_balance = state.current_balance;
            let retired_dir = next_retired_note_dir(&config.state_dir, note_id)?;
            create_private_dir(&retired_dir)?;

            let active_state_path = config.state_dir.join("note_state.json");
            let retired_state_path = retired_dir.join("note_state.json");
            std::fs::rename(&active_state_path, &retired_state_path).map_err(|err| {
                AuthError::Wallet(format!(
                    "failed to retire note {note_id} from {} to {}: {err}",
                    active_state_path.display(),
                    retired_state_path.display()
                ))
            })?;

            Ok(Some(RetiredNote {
                note_id,
                remaining_balance,
                state_dir: retired_dir,
            }))
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
        let trusted_roots = self.trusted_roots();
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

    /// Build the integration config for the client UI, probing the server's
    /// dashboard summary for upstream metadata and credit scale.
    pub async fn zkapi_config(&self) -> ZkapiConfig {
        let summary_url = format!(
            "{}/v1/dashboard/summary",
            self.config.protocol_server_url.trim_end_matches('/')
        );
        let summary =
            tokio::time::timeout(Duration::from_secs(2), fetch_json::<Value>(&summary_url))
                .await
                .ok()
                .and_then(Result::ok);
        let server = summary.as_ref().map(|s| &s["server"]);
        let upstream_kind = server
            .and_then(|s| s["upstream_kind"].as_str())
            .map(|s| s.to_string());
        let credits_per_usd = server
            .and_then(|s| s["credits_per_usd"].as_f64())
            .filter(|v| *v > 0.0)
            .unwrap_or(CREDITS_PER_USD);
        let direct_openrouter_available = server
            .and_then(|server| server["openrouter_leases_enabled"].as_bool())
            .unwrap_or(false);
        let active_lease = self
            .direct_lease
            .lock()
            .await
            .as_ref()
            .map(|lease| DirectLeaseStatus {
                session_id: lease.session_id.clone(),
                client_request_id: lease.client_request_id.clone(),
                expires_at: lease.expires_at,
                settle_after: lease.settle_after,
            });
        let prepared_withdrawal =
            self.prepared_withdrawal
                .lock()
                .await
                .as_ref()
                .map(|plan| PreparedWithdrawalStatus {
                    mode: plan.mode,
                    note_id: plan.public_inputs.note_id,
                    destination: format_address(&plan.public_inputs.destination),
                });

        ZkapiConfig {
            credits_per_usd,
            request_charge_cap: self.config.request_charge_cap,
            request_charge_cap_usd: self.config.request_charge_cap as f64 / credits_per_usd,
            policy_charge_cap: self.config.policy_charge_cap,
            policy_enabled: self.config.policy_enabled,
            funding: self.funding_config(),
            upstream_kind,
            direct_openrouter_available,
            request_mode: self.config.request_mode,
            active_lease,
            prepared_withdrawal,
        }
    }

    /// Fail before funding or listening when a requested transport is not
    /// advertised by the selected server deployment.
    pub async fn ensure_request_mode_available(&self) -> Result<(), AuthError> {
        if self.config.request_mode == RequestMode::Proxy {
            return Ok(());
        }
        let health_url = format!(
            "{}/health",
            self.config.protocol_server_url.trim_end_matches('/')
        );
        let health = fetch_json::<ServerHealthSnapshot>(&health_url)
            .await
            .map_err(AuthError::Wallet)?;
        if health
            .request_modes
            .iter()
            .any(|mode| mode == "direct_openrouter")
        {
            Ok(())
        } else {
            Err(AuthError::InvalidInput(format!(
                "server {} does not advertise direct_openrouter mode",
                self.config.protocol_server_url
            )))
        }
    }

    /// Clear the active note after its on-chain settlement (mutual close or
    /// finalized escape), archiving the closed state so a fresh deposit can
    /// start. Only call once the note is closed on chain — otherwise this drops
    /// the local secret while funds are still escrowed.
    pub async fn reset_wallet(&self) -> Result<WalletStatus, AuthError> {
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        let status = spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let state_path = config.state_dir.join("note_state.json");
            let journal_path = config.state_dir.join("pending_journal.json");
            let prepared_path = prepared_withdrawal_path(&config.state_dir);
            if state_path.exists() {
                // Best-effort archive (moves to archive/note_<id>_closed.json),
                // then ensure the active state file is gone.
                if let Ok(wallet) = load_wallet(&config, Vec::new()) {
                    if let Some(state) = wallet.state() {
                        let _ = state.archive(&state_path);
                    }
                }
                let _ = std::fs::remove_file(&state_path);
            }
            let _ = std::fs::remove_file(&journal_path);
            let _ = std::fs::remove_file(&prepared_path);
            let wallet = load_wallet(&config, Vec::new())?;
            Ok(wallet_status(&wallet))
        })
        .await?;
        *self.prepared_withdrawal.lock().await = None;
        *self.direct_lease.lock().await = None;
        Ok(status)
    }

    pub fn funding_config(&self) -> FundingConfig {
        FundingConfig {
            contract_address: self.config.contract_address,
            chain_id: self.config.chain_id,
            indexer_url: self.config.indexer_url.clone(),
            protocol_server_url: self.config.protocol_server_url.clone(),
            models: self.config.models.clone(),
            suggested_deposit_amount: self.config.suggested_deposit_amount,
            demo_rpc_url: self.config.demo_rpc_url.clone(),
            demo_billing_token_address: self.config.demo_billing_token_address.clone(),
            demo_mint_enabled: self.config.demo_mint_enabled,
            demo_note_ttl_seconds: self.config.demo_note_ttl_seconds,
        }
    }

    pub async fn execute_request(
        self: &Arc<Self>,
        request: CoreRequest,
    ) -> Result<CoreResponse, AuthError> {
        self.execute_request_in_session(request, None).await
    }

    /// Execute an application request, binding direct-mode key reuse to an
    /// explicit chat session. Calls with the same session ID share one bounded
    /// ephemeral key and may run concurrently; a different session cannot
    /// silently inherit that key.
    pub async fn execute_request_in_session(
        self: &Arc<Self>,
        request: CoreRequest,
        session_id: Option<&str>,
    ) -> Result<CoreResponse, AuthError> {
        if let Some(plan) = self.prepared_withdrawal.lock().await.as_ref() {
            return Err(AuthError::WithdrawalPending(format!(
                "{} withdrawal for note {} is prepared; finish it before sending more requests",
                withdrawal_mode_label(plan.mode),
                plan.public_inputs.note_id
            )));
        }
        match self.config.request_mode {
            RequestMode::Proxy => Ok(self.execute_request_demo(request).await?.response),
            RequestMode::DirectOpenrouter => {
                let session_id = normalize_session_id(session_id)?;
                self.execute_direct_openrouter(request, session_id).await
            }
        }
    }

    /// Forward a direct OpenRouter response without buffering its body. The
    /// HTTP route wraps the returned byte stream in an Axum body so SSE chunks
    /// reach OpenAI-compatible callers as soon as OpenRouter emits them. The
    /// returned body owns the inference lock until it is consumed or dropped.
    pub async fn execute_streaming_request(
        self: &Arc<Self>,
        request: CoreRequest,
    ) -> Result<StreamingCoreResponse, AuthError> {
        self.execute_streaming_request_in_session(request, None)
            .await
    }

    pub async fn execute_streaming_request_in_session(
        self: &Arc<Self>,
        request: CoreRequest,
        session_id: Option<&str>,
    ) -> Result<StreamingCoreResponse, AuthError> {
        if let Some(plan) = self.prepared_withdrawal.lock().await.as_ref() {
            return Err(AuthError::WithdrawalPending(format!(
                "{} withdrawal for note {} is prepared; finish it before sending more requests",
                withdrawal_mode_label(plan.mode),
                plan.public_inputs.note_id
            )));
        }
        match self.config.request_mode {
            RequestMode::DirectOpenrouter => {
                let session_id = normalize_session_id(session_id)?;
                self.execute_direct_openrouter_streaming(request, session_id)
                    .await
            }
            RequestMode::Proxy => Err(AuthError::InvalidInput(
                "streaming is available only in direct-openrouter mode".to_string(),
            )),
        }
    }

    /// Reconcile a pending direct-mode lease with the server. `run()` calls
    /// this periodically so the wallet advances soon after authoritative usage
    /// settlement even if no new LLM request arrives.
    pub async fn reconcile_direct_openrouter(&self) {
        if self.config.request_mode != RequestMode::DirectOpenrouter {
            return;
        }
        // A streaming response owns this lock through its final body chunk.
        // Do not race its lease state with periodic crash recovery.
        let Ok(_request_guard) = self.direct_request_mutex.try_write() else {
            return;
        };
        match self.recover().await {
            Ok(result) if result.recovered => {
                let mut lease = self.direct_lease.lock().await;
                *lease = None;
                tracing::info!("installed settled OpenRouter lease state");
            }
            Ok(_) => {}
            Err(error) => tracing::debug!(error = %error, "OpenRouter lease is not settled yet"),
        }
    }

    /// Finish any request that still owns the wallet before producing a
    /// withdrawal proof. In direct mode this deliberately retires a live
    /// child key immediately, so withdrawal charges measured usage without
    /// waiting for the provider-enforced lease expiry.
    pub async fn settle_for_withdrawal(&self) -> Result<WalletStatus, AuthError> {
        let _request_guard = self.direct_request_mutex.write().await;

        if self.config.request_mode == RequestMode::DirectOpenrouter {
            let live_lease_id = self
                .direct_lease
                .lock()
                .await
                .take()
                .map(|lease| lease.client_request_id);

            if let Some(client_request_id) = live_lease_id {
                tracing::info!(
                    %client_request_id,
                    "retiring active OpenRouter lease before withdrawal"
                );
                self.retire_direct_openrouter_lease(&client_request_id)
                    .await?;
            } else if self.status().await?.pending_request {
                // After a daemon restart the plaintext child key is gone, but
                // the retryable prompt-free proof remains in the wallet
                // journal. Use it to retire or recover the authoritative
                // server-side lease.
                let request = self.prepare_direct_lease_request().await?;
                let Some(lease) = self.find_direct_lease_for_withdrawal(&request).await? else {
                    tracing::warn!(
                        client_request_id = %request.client_request_id,
                        "clearing an orphaned local lease proof that the server never accepted"
                    );
                    self.clear_pending_request().await?;
                    let status = self.status().await?;
                    if status.pending_request {
                        return Err(AuthError::PendingRequest);
                    }
                    return Ok(status);
                };
                match lease.status.as_str() {
                    "active" => {
                        self.retire_direct_openrouter_lease(&request.client_request_id)
                            .await?;
                    }
                    "finalized" => {
                        let recovered = self.recover().await?;
                        if !recovered.recovered && recovered.wallet.pending_request {
                            return Err(AuthError::LeasePending(format!(
                                "finalized lease {} is not yet recoverable",
                                request.client_request_id
                            )));
                        }
                    }
                    status => {
                        return Err(AuthError::LeasePending(format!(
                            "lease {} is {status}; key expiry {}, settlement after {}",
                            request.client_request_id, lease.expires_at, lease.settle_after
                        )));
                    }
                }
            }
        } else if self.status().await?.pending_request {
            let recovered = self.recover().await?;
            if !recovered.recovered && recovered.wallet.pending_request {
                return Err(AuthError::PendingRequest);
            }
        }

        let status = self.status().await?;
        if status.pending_request {
            return Err(AuthError::PendingRequest);
        }
        Ok(status)
    }

    /// Resolve an interrupted lease issuance without guessing. A missing
    /// lease is considered safely orphaned only when the current request is
    /// unknown and its nullifier is either also unknown or already reserved
    /// by an idempotently retryable mutual withdrawal.
    async fn find_direct_lease_for_withdrawal(
        &self,
        request: &ApiRequestV2,
    ) -> Result<Option<OpenRouterLeaseStatusResponse>, AuthError> {
        const ATTEMPTS: usize = 3;
        let client_request_id = &request.client_request_id;
        for attempt in 0..ATTEMPTS {
            if let Some(lease) = self
                .fetch_optional_direct_lease_status(client_request_id)
                .await?
            {
                return Ok(Some(lease));
            }
            let recovery = self.fetch_request_recovery(client_request_id).await?;
            if recovery.request_response.is_some() || recovery.nullifier_status == "finalized" {
                let recovered = self.recover().await?;
                if recovered.recovered || !recovered.wallet.pending_request {
                    return Ok(None);
                }
                return Err(AuthError::LeasePending(format!(
                    "request {client_request_id} is finalized but not yet recoverable"
                )));
            }
            if recovery.status != "not_found" || recovery.nullifier_status != "unknown" {
                return Err(AuthError::LeasePending(format!(
                    "request {client_request_id} has server status {} and nullifier status {}",
                    recovery.status, recovery.nullifier_status
                )));
            }
            let nullifier_recovery = self
                .fetch_nullifier_recovery(&request.public_inputs.request_nullifier)
                .await?;
            if nullifier_recovery.nullifier_status == "clearance_reserved" {
                // A previously prepared mutual withdrawal intentionally owns
                // this deterministic state nullifier. The rejected lease was
                // never accepted, so clearing only its local journal is safe
                // and lets withdrawal preparation resume idempotently.
                return Ok(None);
            }
            if nullifier_recovery.status != "not_found"
                || nullifier_recovery.nullifier_status != "unknown"
            {
                return Err(AuthError::LeasePending(format!(
                    "request {client_request_id} is unknown, but its nullifier has server status {} and nullifier status {}",
                    nullifier_recovery.status, nullifier_recovery.nullifier_status
                )));
            }
            if attempt + 1 < ATTEMPTS {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
        Ok(None)
    }

    async fn execute_direct_openrouter(
        self: &Arc<Self>,
        request: CoreRequest,
        session_id: String,
    ) -> Result<CoreResponse, AuthError> {
        let (client_request_id, upstream, retire_after_response, request_guard) = self
            .open_direct_openrouter_response(request, &session_id)
            .await?;
        let status = upstream.status();
        let result = upstream
            .text()
            .await
            .map(|raw_payload| (status, raw_payload))
            .map_err(|error| AuthError::Upstream(error.to_string()));
        if retire_after_response {
            drop(request_guard);
            let _request_guard = self.direct_request_mutex.clone().write_owned().await;
            self.finish_direct_openrouter_lease(client_request_id.clone())
                .await;
        } else {
            drop(request_guard);
        }

        let (status, raw_payload) = result?;
        let response_code = status.as_u16();
        let wallet = self.status().await?;
        let (remaining_balance, next_anchor) = wallet
            .note
            .map(|note| (Some(note.current_balance), note.current_anchor))
            .unwrap_or((None, Felt252::ZERO));
        Ok(CoreResponse {
            client_request_id,
            response_code,
            payload: serde_json::from_str(&raw_payload).ok(),
            raw_payload,
            // The authoritative charge is intentionally unknown until the
            // whole lease settles. Zero here means "not yet applied".
            charge_applied: 0,
            next_anchor,
            remaining_balance,
        })
    }

    async fn ensure_direct_openrouter_lease(
        &self,
        lease_slot: &mut Option<ActiveOpenRouterLease>,
        session_id: &str,
    ) -> Result<(), AuthError> {
        if lease_slot
            .as_ref()
            .is_some_and(|lease| now_seconds().saturating_add(1) < lease.expires_at)
        {
            let lease = lease_slot.as_ref().expect("checked above");
            if lease.session_id != session_id {
                return Err(AuthError::LeaseSessionConflict {
                    active_session_id: lease.session_id.clone(),
                    expires_at: lease.expires_at,
                });
            }
            return Ok(());
        }

        if let Some(finished) = lease_slot.take() {
            tracing::info!(
                client_request_id = %finished.client_request_id,
                expires_at = finished.expires_at,
                requests_served = finished.requests_served,
                "retiring expired OpenRouter lease before opening its replacement"
            );
            self.retire_direct_openrouter_lease(&finished.client_request_id)
                .await?;
        }

        // Recover any state finalized since daemon startup before proving the
        // next lease request. The resulting child key stays in memory and is
        // reused for this OA chat until its provider-enforced expiration, an
        // explicit settlement, credit exhaustion, or a key rejection.
        let _ = self.recover().await?;
        *lease_slot = Some(
            self.issue_direct_openrouter_lease(session_id.to_string())
                .await?,
        );
        Ok(())
    }

    async fn execute_direct_openrouter_streaming(
        self: &Arc<Self>,
        request: CoreRequest,
        session_id: String,
    ) -> Result<StreamingCoreResponse, AuthError> {
        let (client_request_id, upstream, retire_after_response, request_guard) = self
            .open_direct_openrouter_response(request, &session_id)
            .await?;
        let status = upstream.status();
        let content_type = upstream
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .cloned();
        let cache_control = upstream
            .headers()
            .get(reqwest::header::CACHE_CONTROL)
            .cloned();
        let finalizer = DirectOpenRouterStreamFinalizer {
            service: self.clone(),
            client_request_id: retire_after_response.then_some(client_request_id),
            request_guard: Some(request_guard),
        };
        let state = (upstream.bytes_stream().boxed(), Some(finalizer), false);
        let body = stream::unfold(state, |(mut upstream, mut finalizer, done)| async move {
            if done {
                return None;
            }
            match upstream.next().await {
                Some(Ok(chunk)) => Some((Ok(chunk), (upstream, finalizer, false))),
                Some(Err(error)) => {
                    drop(finalizer.take());
                    Some((Err(io::Error::other(error)), (upstream, finalizer, true)))
                }
                None => {
                    drop(finalizer.take());
                    None
                }
            }
        })
        .boxed();
        Ok(StreamingCoreResponse {
            status,
            content_type,
            cache_control,
            body,
        })
    }

    async fn open_direct_openrouter_response(
        self: &Arc<Self>,
        request: CoreRequest,
        session_id: &str,
    ) -> Result<
        (
            String,
            reqwest::Response,
            bool,
            tokio::sync::OwnedRwLockReadGuard<()>,
        ),
        AuthError,
    > {
        self.ensure_scheme_agreement().await?;
        let (upstream_path, upstream_body) =
            crate::compat::openrouter_request(&request.path, request.body);
        let mut replaced_rejected_key = false;
        loop {
            let request_guard = self.direct_request_mutex.clone().read_owned().await;
            let mut lease_slot = self.direct_lease.lock().await;
            self.ensure_direct_openrouter_lease(&mut lease_slot, session_id)
                .await?;
            let lease = lease_slot
                .as_mut()
                .ok_or_else(|| AuthError::Wallet("OpenRouter lease disappeared".to_string()))?;
            if !lease.verified {
                let evidence = lease.verification.clone().ok_or_else(|| {
                    AuthError::KeyVerification(
                        "OA lease lost its verification evidence".to_string(),
                    )
                })?;
                self.verify_oa_key(&lease.api_key, lease.expires_at, &evidence)
                    .await?;
                if now_seconds().saturating_add(1) >= lease.expires_at {
                    return Err(AuthError::KeyVerification(
                        "OA key expired while verification was in progress".to_string(),
                    ));
                }
                lease.verified = true;
            }
            let client_request_id = lease.client_request_id.clone();
            let mut reserved_lease = lease.clone();
            lease.requests_served = lease.requests_served.saturating_add(1);
            let retire_after_response = false;
            drop(lease_slot);
            match self
                .send_verified_openrouter_request(
                    &mut reserved_lease,
                    &upstream_path,
                    &upstream_body,
                )
                .await
            {
                Ok(response) => {
                    return Ok((
                        client_request_id,
                        response,
                        retire_after_response,
                        request_guard,
                    ))
                }
                Err(error)
                    if !replaced_rejected_key
                        && (is_rejected_openrouter_key(&error)
                            || (reserved_lease.requests_served > 0
                                && is_exhausted_openrouter_key(&error))) =>
                {
                    tracing::warn!(
                        %client_request_id,
                        error = %error,
                        "retiring rejected OpenRouter lease and opening one replacement"
                    );
                    drop(request_guard);
                    let _request_guard = self.direct_request_mutex.clone().write_owned().await;
                    let mut lease_slot = self.direct_lease.lock().await;
                    if lease_slot
                        .as_ref()
                        .is_some_and(|lease| lease.client_request_id == client_request_id)
                    {
                        *lease_slot = None;
                    }
                    drop(lease_slot);
                    self.retire_direct_openrouter_lease(&client_request_id)
                        .await?;
                    replaced_rejected_key = true;
                }
                Err(error) => {
                    drop(request_guard);
                    let _request_guard = self.direct_request_mutex.clone().write_owned().await;
                    let mut lease_slot = self.direct_lease.lock().await;
                    if lease_slot
                        .as_ref()
                        .is_some_and(|lease| lease.client_request_id == client_request_id)
                    {
                        *lease_slot = None;
                    }
                    drop(lease_slot);
                    if let Err(cleanup_error) = self
                        .retire_direct_openrouter_lease(&client_request_id)
                        .await
                    {
                        tracing::warn!(
                            %client_request_id,
                            error = %cleanup_error,
                            "could not retire rejected OpenRouter lease"
                        );
                    }
                    return Err(error);
                }
            }
        }
    }

    async fn send_verified_openrouter_request(
        &self,
        lease: &mut ActiveOpenRouterLease,
        upstream_path: &str,
        upstream_body: &Value,
    ) -> Result<reqwest::Response, AuthError> {
        if !lease.verified {
            let evidence = lease.verification.clone().ok_or_else(|| {
                AuthError::KeyVerification("OA lease lost its verification evidence".to_string())
            })?;
            self.verify_oa_key(&lease.api_key, lease.expires_at, &evidence)
                .await?;
            if now_seconds().saturating_add(1) >= lease.expires_at {
                return Err(AuthError::KeyVerification(
                    "OA key expired while verification was in progress".to_string(),
                ));
            }
            lease.verified = true;
        }
        let url = format!(
            "{}{}",
            lease.openrouter_api_base.trim_end_matches('/'),
            upstream_path
        );
        self.send_openrouter_request(&url, &lease.api_key, upstream_body, lease.expires_at)
            .await
    }

    async fn send_openrouter_request(
        &self,
        url: &str,
        api_key: &str,
        body: &Value,
        expires_at: u64,
    ) -> Result<reqwest::Response, AuthError> {
        for attempt in 1..=DIRECT_REMOTE_MAX_ATTEMPTS {
            let response = match self
                .http
                .post(url)
                .bearer_auth(api_key)
                .header("content-type", "application/json")
                .json(body)
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    if attempt < DIRECT_REMOTE_MAX_ATTEMPTS {
                        let delay = direct_remote_retry_delay(attempt, None);
                        if retry_fits_lease(expires_at, delay) {
                            tracing::warn!(
                                attempt,
                                error = %error,
                                "retrying transient OpenRouter transport failure"
                            );
                            tokio::time::sleep(delay).await;
                            continue;
                        }
                    }
                    return Err(AuthError::Upstream(error.to_string()));
                }
            };
            let status = response.status();
            let retry_after = retry_after_delay(response.headers());
            if status.is_success() {
                return Ok(response);
            }
            let raw_payload = response
                .text()
                .await
                .map_err(|error| AuthError::Upstream(error.to_string()))?;
            if is_transient_remote_status(status) && attempt < DIRECT_REMOTE_MAX_ATTEMPTS {
                let delay = direct_remote_retry_delay(attempt, retry_after);
                if retry_fits_lease(expires_at, delay) {
                    tracing::warn!(
                        attempt,
                        %status,
                        delay_ms = delay.as_millis(),
                        "retrying transient OpenRouter inference failure"
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }
            }
            return Err(AuthError::UpstreamResponse {
                status,
                message: truncate_for_error(&raw_payload, 500),
            });
        }
        Err(AuthError::Upstream(
            "OpenRouter request exhausted its retry budget".to_string(),
        ))
    }

    async fn issue_direct_openrouter_lease(
        &self,
        session_id: String,
    ) -> Result<ActiveOpenRouterLease, AuthError> {
        let mut retried_stale_root = false;
        let mut reconciled_lost_key = false;
        loop {
            let request = self.prepare_direct_lease_request().await?;
            let response = self
                .http
                .post(format!(
                    "{}/v2/openrouter/leases",
                    self.config.protocol_server_url.trim_end_matches('/')
                ))
                .json(&request)
                .send()
                .await
                .map_err(|error| AuthError::Wallet(error.to_string()))?;
            let status = response.status();
            let body = response
                .text()
                .await
                .map_err(|error| AuthError::Wallet(error.to_string()))?;
            if status.is_success() {
                let lease: OpenRouterLeaseResponse = serde_json::from_str(&body)
                    .map_err(|error| AuthError::Serialization(error.to_string()))?;
                let extensions: OpenRouterLeaseExtensions = serde_json::from_str(&body)
                    .map_err(|error| AuthError::Serialization(error.to_string()))?;
                if lease.api_key.is_empty() || lease.expires_at <= now_seconds() {
                    return Err(AuthError::Wallet(
                        "server returned an unusable OpenRouter lease".to_string(),
                    ));
                }
                let expected_inference = &self.config.openrouter_inference_base;
                if !matches_trusted_url(&lease.openrouter_api_base, expected_inference) {
                    return Err(AuthError::KeyVerification(
                        "lease inference origin does not match the client's trusted OpenRouter origin"
                            .to_string(),
                    ));
                }
                let (verification, verified) = match extensions.key_source.as_str() {
                    "openrouter" => {
                        enforce_required_key_source(
                            self.config.require_oa_org_key_source,
                            "openrouter",
                        )?;
                        if extensions.verification.is_some() {
                            return Err(AuthError::KeyVerification(
                                "direct OpenRouter lease included unexpected OA evidence"
                                    .to_string(),
                            ));
                        }
                        (None, true)
                    }
                    "oa_org" => {
                        let evidence = extensions.verification.ok_or_else(|| {
                            AuthError::KeyVerification(
                                "OA org lease omitted verification evidence".to_string(),
                            )
                        })?;
                        (Some(evidence), false)
                    }
                    source => {
                        return Err(AuthError::KeyVerification(format!(
                            "server returned unsupported key source {source}"
                        )))
                    }
                };
                tracing::info!(
                    client_request_id = %lease.client_request_id,
                    expires_at = lease.expires_at,
                    "opened prompt-private OpenRouter lease"
                );
                return Ok(ActiveOpenRouterLease {
                    session_id,
                    client_request_id: lease.client_request_id,
                    api_key: lease.api_key,
                    openrouter_api_base: lease.openrouter_api_base,
                    expires_at: lease.expires_at,
                    settle_after: lease.settle_after,
                    verification,
                    verified,
                    requests_served: 0,
                });
            }
            if let Ok(error) = serde_json::from_str::<ErrorResponse>(&body) {
                if error.error_code == "stale_root" && !retried_stale_root {
                    self.clear_pending_request().await?;
                    retried_stale_root = true;
                    continue;
                }
                if error.error_code == "lease_pending" {
                    let lease_status = self
                        .fetch_direct_lease_status(&request.client_request_id)
                        .await?;
                    if reconciled_lost_key {
                        return Err(AuthError::LeasePending(format!(
                            "lease {} is still {} after local recovery",
                            lease_status.client_request_id, lease_status.status
                        )));
                    }
                    match lease_status.status.as_str() {
                        "active" => {
                            // A restarted daemon intentionally has no copy of
                            // the one-show runtime key. Retire that unusable
                            // lease immediately, recover its wallet update,
                            // and prove a fresh lease in this same request.
                            tracing::warn!(
                                client_request_id = %lease_status.client_request_id,
                                expires_at = lease_status.expires_at,
                                "retiring active OpenRouter lease whose local key was lost"
                            );
                            self.retire_direct_openrouter_lease(&lease_status.client_request_id)
                                .await?;
                        }
                        "finalized" => {
                            let recovered = self.recover().await?;
                            if !recovered.recovered && recovered.wallet.pending_request {
                                return Err(AuthError::LeasePending(format!(
                                    "finalized lease {} is not yet recoverable",
                                    lease_status.client_request_id
                                )));
                            }
                        }
                        _ => {
                            return Err(AuthError::LeasePending(format!(
                                "lease {} is {}; key expiry {}, settlement after {}",
                                lease_status.client_request_id,
                                lease_status.status,
                                lease_status.expires_at,
                                lease_status.settle_after
                            )));
                        }
                    }
                    reconciled_lost_key = true;
                    continue;
                }
                return Err(AuthError::Wallet(format!(
                    "{}: {}",
                    error.error_code, error.error_message
                )));
            }
            return Err(AuthError::Wallet(format!("HTTP {status}: {body}")));
        }
    }

    async fn verify_oa_key(
        &self,
        api_key: &str,
        expires_at: u64,
        evidence: &OaKeyVerificationEvidence,
    ) -> Result<(), AuthError> {
        let expected_verifier = self.config.oa_verifier_url.trim_end_matches('/');
        if !matches_trusted_url(&evidence.verifier_url, expected_verifier) {
            return Err(AuthError::KeyVerification(
                "lease verifier does not match the client's trusted OA verifier".to_string(),
            ));
        }
        validate_oa_key_evidence(expires_at, evidence)?;
        let url = format!("{expected_verifier}/submit_key");
        let request = serde_json::json!({
            "station_id": evidence.station_id,
            "api_key": api_key,
            "key_valid_till": evidence.key_valid_till,
            "station_signature": evidence.station_signature,
            "org_signature": evidence.org_signature,
        });
        for attempt in 1..=DIRECT_REMOTE_MAX_ATTEMPTS {
            let response = match self.http.post(&url).json(&request).send().await {
                Ok(response) => response,
                Err(error) => {
                    if attempt < DIRECT_REMOTE_MAX_ATTEMPTS {
                        let delay = direct_remote_retry_delay(attempt, None);
                        if retry_fits_lease(expires_at, delay) {
                            tracing::warn!(
                                attempt,
                                error = %error,
                                "retrying transient OA verifier transport failure"
                            );
                            tokio::time::sleep(delay).await;
                            continue;
                        }
                    }
                    return Err(AuthError::KeyVerification(format!(
                        "verifier request failed: {error}"
                    )));
                }
            };
            let status = response.status();
            let retry_after = retry_after_delay(response.headers());
            let body = response.text().await.map_err(|error| {
                AuthError::KeyVerification(format!("invalid verifier response: {error}"))
            })?;
            let result: Value = match serde_json::from_str(&body) {
                Ok(result) => result,
                Err(error)
                    if is_transient_remote_status(status)
                        && attempt < DIRECT_REMOTE_MAX_ATTEMPTS =>
                {
                    let delay = direct_remote_retry_delay(attempt, retry_after);
                    if retry_fits_lease(expires_at, delay) {
                        tracing::warn!(
                            attempt,
                            %status,
                            error = %error,
                            "retrying invalid transient OA verifier response"
                        );
                        tokio::time::sleep(delay).await;
                        continue;
                    }
                    return Err(AuthError::KeyVerification(format!(
                        "invalid verifier response: {error}"
                    )));
                }
                Err(error) => {
                    return Err(AuthError::KeyVerification(format!(
                        "invalid verifier response: {error}"
                    )))
                }
            };
            if status.is_success()
                && result.get("status").and_then(Value::as_str) == Some("verified")
            {
                tracing::info!(
                    station_id = %evidence.station_id,
                    recently_attested = evidence.station_recently_attested,
                    "OA verifier accepted station-issued OpenRouter key"
                );
                return Ok(());
            }
            let retryable = result
                .get("retryable")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || is_transient_remote_status(status);
            if retryable && attempt < DIRECT_REMOTE_MAX_ATTEMPTS {
                let delay = direct_remote_retry_delay(attempt, retry_after);
                if retry_fits_lease(expires_at, delay) {
                    tracing::warn!(
                        attempt,
                        %status,
                        delay_ms = delay.as_millis(),
                        "retrying transient OA key verification failure"
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }
            }
            let detail = result
                .get("detail")
                .and_then(Value::as_str)
                .unwrap_or("station key was not verified");
            return Err(AuthError::KeyVerification(format!(
                "trusted verifier rejected the station key (HTTP {status}: {detail})"
            )));
        }
        Err(AuthError::KeyVerification(
            "OA verifier request exhausted its retry budget".to_string(),
        ))
    }

    async fn prepare_direct_lease_request(&self) -> Result<ApiRequestV2, AuthError> {
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        let indexer = self.indexer.clone();
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|error| AuthError::Wallet(error.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let mut wallet = load_wallet(&config, Vec::new())?;
            let authorization = serde_json::to_string(&OpenRouterLeaseAuthorization::default())
                .map_err(|error| AuthError::Serialization(error.to_string()))?;
            if wallet.has_pending_request() {
                let request = wallet.pending_api_request()?.ok_or_else(|| {
                    AuthError::LeasePending(
                        "an older pending request has no retryable request body".to_string(),
                    )
                })?;
                if request.payload != authorization {
                    return Err(AuthError::LeasePending(
                        "a non-lease zkAPI request is still pending".to_string(),
                    ));
                }
                return Ok(request);
            }
            let state = wallet.state().ok_or(AuthError::NoActiveNote)?;
            let note_id = state.note_id;
            let runtime = current_thread_runtime()?;
            let (active_root, siblings) = runtime.block_on(async move {
                Ok::<_, AuthError>((indexer.root().await?, indexer.note_path(note_id).await?))
            })?;
            let payload_hash = compute_payload_hash(authorization.as_bytes());
            wallet
                .prepare_request(&authorization, payload_hash, active_root, siblings)
                .map_err(Into::into)
        })
        .await
    }

    async fn clear_pending_request(&self) -> Result<(), AuthError> {
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|error| AuthError::Wallet(error.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let wallet = load_wallet(&config, Vec::new())?;
            wallet.clear_pending_request()?;
            Ok(())
        })
        .await
    }

    async fn fetch_direct_lease_status(
        &self,
        client_request_id: &str,
    ) -> Result<OpenRouterLeaseStatusResponse, AuthError> {
        self.http
            .get(format!(
                "{}/v2/openrouter/leases/{client_request_id}",
                self.config.protocol_server_url.trim_end_matches('/')
            ))
            .send()
            .await
            .map_err(|error| AuthError::Wallet(error.to_string()))?
            .error_for_status()
            .map_err(|error| AuthError::Wallet(error.to_string()))?
            .json()
            .await
            .map_err(|error| AuthError::Serialization(error.to_string()))
    }

    async fn fetch_optional_direct_lease_status(
        &self,
        client_request_id: &str,
    ) -> Result<Option<OpenRouterLeaseStatusResponse>, AuthError> {
        let response = self
            .http
            .get(format!(
                "{}/v2/openrouter/leases/{client_request_id}",
                self.config.protocol_server_url.trim_end_matches('/')
            ))
            .send()
            .await
            .map_err(|error| AuthError::Wallet(error.to_string()))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let response = response
            .error_for_status()
            .map_err(|error| AuthError::Wallet(error.to_string()))?;
        response
            .json()
            .await
            .map(Some)
            .map_err(|error| AuthError::Serialization(error.to_string()))
    }

    async fn fetch_request_recovery(
        &self,
        client_request_id: &str,
    ) -> Result<RecoveryResponseV2, AuthError> {
        self.http
            .get(format!(
                "{}/v2/requests/{client_request_id}",
                self.config.protocol_server_url.trim_end_matches('/')
            ))
            .send()
            .await
            .map_err(|error| AuthError::Wallet(error.to_string()))?
            .error_for_status()
            .map_err(|error| AuthError::Wallet(error.to_string()))?
            .json()
            .await
            .map_err(|error| AuthError::Serialization(error.to_string()))
    }

    async fn fetch_nullifier_recovery(
        &self,
        nullifier: &Felt252,
    ) -> Result<RecoveryResponseV2, AuthError> {
        self.http
            .get(format!(
                "{}/v2/nullifiers/{}",
                self.config.protocol_server_url.trim_end_matches('/'),
                nullifier
            ))
            .send()
            .await
            .map_err(|error| AuthError::Wallet(error.to_string()))?
            .error_for_status()
            .map_err(|error| AuthError::Wallet(error.to_string()))?
            .json()
            .await
            .map_err(|error| AuthError::Serialization(error.to_string()))
    }

    async fn retire_direct_openrouter_lease(
        &self,
        client_request_id: &str,
    ) -> Result<(), AuthError> {
        let request = self.prepare_direct_lease_request().await?;
        if request.client_request_id != client_request_id {
            return Err(AuthError::LeasePending(
                "pending proof does not match the rejected OpenRouter lease".to_string(),
            ));
        }
        let deadline = Instant::now() + DIRECT_LEASE_RETIRE_MAX_WAIT;
        let status = loop {
            let response = self
                .http
                .post(format!(
                    "{}/v2/openrouter/leases/{client_request_id}",
                    self.config.protocol_server_url.trim_end_matches('/')
                ))
                .json(&request)
                .send()
                .await
                .map_err(|error| AuthError::Wallet(error.to_string()))?;
            let http_status = response.status();
            let body = response
                .text()
                .await
                .map_err(|error| AuthError::Wallet(error.to_string()))?;
            if http_status.is_success() {
                break serde_json::from_str::<OpenRouterLeaseStatusResponse>(&body)
                    .map_err(|error| AuthError::Serialization(error.to_string()))?;
            }
            if let Ok(error) = serde_json::from_str::<ErrorResponse>(&body) {
                if error.retriable && Instant::now() + DIRECT_LEASE_RETIRE_POLL_INTERVAL < deadline
                {
                    tokio::time::sleep(DIRECT_LEASE_RETIRE_POLL_INTERVAL).await;
                    continue;
                }
                if error.error_code == "lease_pending" {
                    return Err(AuthError::LeasePending(format!(
                        "lease {client_request_id} usage is not finalized yet"
                    )));
                }
                return Err(AuthError::Wallet(format!(
                    "{}: {}",
                    error.error_code, error.error_message
                )));
            }
            return Err(AuthError::Wallet(format!("HTTP {http_status}: {body}")));
        };
        if status.status != "finalized" {
            return Err(AuthError::LeasePending(format!(
                "lease {} was not finalized during retirement",
                status.client_request_id
            )));
        }
        if !self.recover().await?.recovered {
            return Err(AuthError::LeasePending(format!(
                "lease {client_request_id} retired but its wallet update is not recoverable"
            )));
        }
        Ok(())
    }

    async fn finish_direct_openrouter_lease(&self, client_request_id: String) {
        tracing::info!(
            %client_request_id,
            "retiring OpenRouter lease"
        );
        if let Err(error) = self
            .retire_direct_openrouter_lease(&client_request_id)
            .await
        {
            tracing::warn!(
                %client_request_id,
                error = %error,
                "OpenRouter lease settlement will resume on the next request"
            );
        }
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
            runtime_proof_backend: self.config.proof_backend_label().to_string(),
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
        self.ensure_scheme_agreement().await?;
        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        let indexer = self.indexer.clone();
        let trusted_roots = self.trusted_roots();
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
                let started = Instant::now();
                tracing::info!(
                    note_id,
                    method = %request.method,
                    path = %request.path,
                    "preparing local Groth16 authorization proof"
                );
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
                            tracing::info!(
                                note_id,
                                elapsed_ms = started.elapsed().as_millis(),
                                charge_applied = response.charge_applied,
                                "local proof and upstream request completed"
                            );
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
                        Err(err) => {
                            tracing::warn!(
                                note_id,
                                elapsed_ms = started.elapsed().as_millis(),
                                error = %err,
                                "local proof or upstream request failed"
                            );
                            return Err(err.into());
                        }
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
        let mut prepared = self.prepared_withdrawal.lock().await;
        if let Some(plan) = prepared.as_ref() {
            let same_destination = plan.public_inputs.destination == destination;
            if plan.mode == mode && same_destination {
                return Ok(plan.clone());
            }
            // A cancelled mutual close cannot safely return to ordinary
            // spending because its clearance nullifier has been reserved by
            // the server. Falling back to the unilateral escape path for the
            // same destination is the recovery mechanism.
            if !(plan.mode == WithdrawalMode::Mutual
                && mode == WithdrawalMode::Escape
                && same_destination)
            {
                return Err(AuthError::WithdrawalPending(format!(
                    "{} withdrawal for note {} is already prepared for {}",
                    withdrawal_mode_label(plan.mode),
                    plan.public_inputs.note_id,
                    format_address(&plan.public_inputs.destination)
                )));
            }
        }

        // A proof must bind the authoritative post-lease wallet state. Hold
        // the prepared-withdrawal lock while reconciling so no new UI/API
        // request can pass the withdrawal guard and open a competing lease.
        self.reconcile_direct_openrouter().await;
        if let Some(lease) = self.direct_lease.lock().await.as_ref() {
            return Err(AuthError::LeasePending(format!(
                "chat {} owns an unsettled key until {}; wait for settlement before withdrawing",
                lease.session_id, lease.expires_at
            )));
        }

        let config = self.config.clone();
        let wallet_mutex = self.wallet_mutex.clone();
        let indexer = self.indexer.clone();
        let trusted_roots = self.trusted_roots();
        let plan = spawn_blocking(move || {
            let _guard = wallet_mutex
                .lock()
                .map_err(|err| AuthError::Wallet(err.to_string()))?;
            let _lockfile = acquire_wallet_lock(&config.state_dir)?;
            let wallet = load_wallet(&config, trusted_roots)?;
            let runtime = current_thread_runtime()?;

            runtime.block_on(async move {
                let note_id = wallet.state().ok_or(AuthError::NoActiveNote)?.note_id;
                let root = indexer.root().await?;
                let siblings = indexer.note_path(note_id).await?;
                let plan_siblings = siblings.clone();
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
                    siblings: plan_siblings,
                    proof,
                })
            })
        })
        .await?;
        *prepared = Some(plan.clone());
        persist_prepared_withdrawal(&self.config.state_dir, &plan)?;
        Ok(plan)
    }

    /// Read the vault's canonical note status before changing local wallet
    /// state. Closed notes are archived locally; pending escape withdrawals
    /// retain their secret until finalization; challenged escapes return to
    /// active use and clear the prepared-withdrawal guard.
    pub async fn confirm_withdrawal(&self) -> Result<WithdrawalChainStatus, AuthError> {
        let wallet_before = self.status().await?;
        let note_id = wallet_before
            .note
            .as_ref()
            .ok_or(AuthError::NoActiveNote)?
            .note_id;
        let (status, challenge_deadline) = self.onchain_withdrawal_status(note_id).await?;
        match status.as_str() {
            "closed" => {
                *self.prepared_withdrawal.lock().await = None;
                *self.direct_lease.lock().await = None;
                let wallet = self.reset_wallet().await?;
                Ok(WithdrawalChainStatus {
                    note_id,
                    status,
                    challenge_deadline: None,
                    wallet,
                })
            }
            "active" => {
                // An escape withdrawal can return to Active only after a
                // successful challenge. Its old proof must never be reused.
                let mut prepared = self.prepared_withdrawal.lock().await;
                if prepared
                    .as_ref()
                    .is_some_and(|plan| plan.mode == WithdrawalMode::Escape)
                {
                    *prepared = None;
                    remove_prepared_withdrawal(&self.config.state_dir)?;
                }
                Ok(WithdrawalChainStatus {
                    note_id,
                    status,
                    challenge_deadline: None,
                    wallet: wallet_before,
                })
            }
            "pending_withdrawal" => Ok(WithdrawalChainStatus {
                note_id,
                status,
                challenge_deadline,
                wallet: wallet_before,
            }),
            other => Err(AuthError::Wallet(format!(
                "vault returned unsupported note status {other}"
            ))),
        }
    }

    async fn onchain_withdrawal_status(
        &self,
        note_id: u32,
    ) -> Result<(String, Option<u64>), AuthError> {
        let notes_data = format!("0x9f18e4ed{:064x}", note_id);
        let encoded_note = self.vault_eth_call(&notes_data).await?;
        let note_words = abi_words(&encoded_note)?;
        if note_words.len() < 4 {
            return Err(AuthError::Wallet(
                "vault notes() returned a truncated response".to_string(),
            ));
        }
        let raw_status = abi_word_u64(note_words[3])?;
        match raw_status {
            1 => Ok(("active".to_string(), None)),
            2 => {
                let pending_data = format!("0xa2f9f1ce{:064x}", note_id);
                let encoded_pending = self.vault_eth_call(&pending_data).await?;
                let pending_words = abi_words(&encoded_pending)?;
                if pending_words.len() < 6 || abi_word_u64(pending_words[0])? != 1 {
                    return Err(AuthError::Wallet(
                        "vault pending-withdrawal record is missing".to_string(),
                    ));
                }
                Ok((
                    "pending_withdrawal".to_string(),
                    Some(abi_word_u64(pending_words[5])?),
                ))
            }
            3 => Ok(("closed".to_string(), None)),
            0 => Err(AuthError::Wallet(format!(
                "vault note {note_id} is uninitialized"
            ))),
            other => Err(AuthError::Wallet(format!(
                "vault note {note_id} has unknown status {other}"
            ))),
        }
    }

    async fn vault_eth_call(&self, data: &str) -> Result<String, AuthError> {
        let rpc_url = self.config.demo_rpc_url.as_ref().ok_or_else(|| {
            AuthError::InvalidInput(
                "deployment does not advertise an RPC URL for withdrawal confirmation".to_string(),
            )
        })?;
        let response = self
            .http
            .post(rpc_url)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "eth_call",
                "params": [{
                    "to": format_felt_address(&self.config.contract_address),
                    "data": data,
                }, "latest"],
            }))
            .send()
            .await
            .map_err(|error| AuthError::Wallet(format!("RPC call failed: {error}")))?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .map_err(|error| AuthError::Wallet(format!("invalid RPC response: {error}")))?;
        if !status.is_success() || payload.get("error").is_some() {
            return Err(AuthError::Wallet(format!(
                "RPC eth_call failed: {}",
                payload
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| Value::String(status.to_string()))
            )));
        }
        payload
            .get("result")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| AuthError::Wallet("RPC eth_call omitted result".to_string()))
    }

    pub fn funding_index_html(&self) -> &'static str {
        include_str!("../../../funding-page/index.html")
    }

    pub fn funding_styles_css(&self) -> &'static str {
        include_str!("../../../funding-page/styles.css")
    }

    pub fn funding_oa_license(&self) -> &'static str {
        include_str!("../../../funding-page/OA_CHAT_LICENSE")
    }

    pub fn funding_app_js(&self) -> &'static str {
        include_str!("../../../funding-page/app.js")
    }

    pub fn funding_wallet_js(&self) -> &'static str {
        include_str!("../../../funding-page/wallet.js")
    }

    pub fn funding_asset(&self, path: &str) -> Option<(&'static [u8], &'static str)> {
        embedded_funding_asset(path)
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

    /// Return the explicitly configured, on-chain-verified signing-root
    /// registry. Server attestation is observability data, not a trust anchor.
    fn trusted_roots(&self) -> Vec<EpochRoots> {
        self.config.trusted_epoch_roots.clone()
    }

    /// Fail fast if the server runs a different authentication method than this
    /// client is configured for (the swappable-auth handshake). Servers that
    /// predate scheme reporting return an empty value and are not rejected.
    async fn ensure_scheme_agreement(&self) -> Result<(), AuthError> {
        let attestation_url = format!(
            "{}/v1/attestation",
            self.config.protocol_server_url.trim_end_matches('/')
        );
        if let Ok(att) = fetch_json::<ServerAttestationSnapshot>(&attestation_url).await {
            let want = self.config.auth_scheme.as_str();
            if !att.auth_scheme.is_empty() && att.auth_scheme != want {
                return Err(AuthError::Wallet(format!(
                    "auth scheme mismatch: client is '{}', server is '{}'",
                    want, att.auth_scheme
                )));
            }
        }
        Ok(())
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

fn core_response(response: &RequestResponseV2, remaining_balance: Option<u128>) -> CoreResponse {
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

fn protocol_response_trace(response: &RequestResponseV2) -> ProtocolResponseTrace {
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
        next_state_sig_epoch: 0,
        next_state_sig_root: response.next_state_signature.r_x,
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

fn withdrawal_mode_label(mode: WithdrawalMode) -> &'static str {
    match mode {
        WithdrawalMode::Mutual => "mutual-close",
        WithdrawalMode::Escape => "escape-hatch",
    }
}

fn format_address(address: &[u8; 20]) -> String {
    let body = address
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("0x{body}")
}

fn format_felt_address(address: &Felt252) -> String {
    let raw = address.to_hex();
    let body = raw.strip_prefix("0x").unwrap_or(&raw);
    format!("0x{body:0>40}")
}

fn abi_words(value: &str) -> Result<Vec<&str>, AuthError> {
    let encoded = value.strip_prefix("0x").unwrap_or(value);
    if encoded.is_empty() || !encoded.len().is_multiple_of(64) || !encoded.is_ascii() {
        return Err(AuthError::Wallet(
            "RPC returned malformed ABI data".to_string(),
        ));
    }
    encoded
        .as_bytes()
        .chunks_exact(64)
        .map(|chunk| {
            std::str::from_utf8(chunk)
                .map_err(|_| AuthError::Wallet("RPC returned malformed ABI data".to_string()))
        })
        .collect()
}

fn abi_word_u64(word: &str) -> Result<u64, AuthError> {
    if word.len() != 64
        || !word.bytes().all(|byte| byte.is_ascii_hexdigit())
        || word[..48].bytes().any(|byte| byte != b'0')
    {
        return Err(AuthError::Wallet(
            "RPC ABI integer does not fit in u64".to_string(),
        ));
    }
    u64::from_str_radix(&word[48..], 16)
        .map_err(|_| AuthError::Wallet("RPC returned malformed ABI integer".to_string()))
}

fn hash_payload(payload: &str) -> Felt252 {
    compute_payload_hash(payload.as_bytes())
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn normalize_session_id(session_id: Option<&str>) -> Result<String, AuthError> {
    const DEFAULT_SESSION: &str = "default";
    let value = session_id.unwrap_or(DEFAULT_SESSION).trim();
    if value.is_empty() || value.len() > 128 {
        return Err(AuthError::InvalidInput(
            "x-zkapi-session-id must contain 1 to 128 characters".to_string(),
        ));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(AuthError::InvalidInput(
            "x-zkapi-session-id may contain only letters, digits, '-', '_', '.', and ':'"
                .to_string(),
        ));
    }
    Ok(value.to_string())
}

fn truncate_for_error(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let end = value
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= max)
        .last()
        .unwrap_or(0);
    format!("{}…", &value[..end])
}

fn is_transient_remote_status(status: reqwest::StatusCode) -> bool {
    matches!(
        status.as_u16(),
        408 | 425 | 429 | 500 | 502 | 503 | 504 | 524 | 529
    )
}

fn is_rejected_openrouter_key(error: &AuthError) -> bool {
    match error {
        AuthError::UpstreamResponse { status, .. }
            if *status == reqwest::StatusCode::UNAUTHORIZED =>
        {
            true
        }
        AuthError::UpstreamResponse { status, message }
            if *status == reqwest::StatusCode::FORBIDDEN =>
        {
            // OpenRouter also reports an exhausted total key limit as 403.
            // Match the structured error message narrowly because unrelated
            // permission and guardrail failures use the same status.
            is_openrouter_total_key_limit_error(message)
        }
        _ => false,
    }
}

fn is_exhausted_openrouter_key(error: &AuthError) -> bool {
    matches!(
        error,
        AuthError::UpstreamResponse { status, .. }
            if *status == reqwest::StatusCode::PAYMENT_REQUIRED
    )
}

fn is_openrouter_total_key_limit_error(message: &str) -> bool {
    serde_json::from_str::<Value>(message)
        .ok()
        .and_then(|body| {
            body.get("error")?
                .get("message")?
                .as_str()
                .map(str::to_owned)
        })
        .is_some_and(|message| message.starts_with("Key limit exceeded (total limit)"))
}

fn retry_after_delay(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_secs)
}

fn direct_remote_retry_delay(attempt: usize, retry_after: Option<Duration>) -> Duration {
    let shift = attempt.saturating_sub(1).min(8) as u32;
    let backoff = DIRECT_REMOTE_RETRY_BASE_DELAY.saturating_mul(1u32 << shift);
    retry_after.unwrap_or_else(|| backoff.min(DIRECT_REMOTE_RETRY_MAX_DELAY))
}

fn retry_fits_lease(expires_at: u64, delay: Duration) -> bool {
    let delay_seconds = delay
        .as_secs()
        .saturating_add(u64::from(delay.subsec_nanos() > 0));
    now_seconds()
        .saturating_add(delay_seconds)
        .saturating_add(1)
        < expires_at
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
    let registration_commitment = core_v2::registration_commitment(&state.secret_s);
    let note_leaf = core_v2::note_leaf(
        state.note_id,
        &registration_commitment,
        state.deposit_amount,
        state.expiry_ts,
    );
    let request_nullifier = core_v2::nullifier(&state.secret_s, &state.current_anchor);
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
        state_sig_epoch: 0,
        state_sig_root: config.state_signing_key.x,
        runtime_proof_backend: config.proof_backend_label().to_string(),
    })
}

fn wallet_lock_path(state_dir: &Path) -> PathBuf {
    state_dir.join(".wallet.lock")
}

fn next_retired_note_dir(state_dir: &Path, note_id: u32) -> Result<PathBuf, AuthError> {
    let retired_root = state_dir.join("retired");
    create_private_dir(&retired_root)?;
    for suffix in 1u32.. {
        let name = if suffix == 1 {
            format!("note_{note_id}")
        } else {
            format!("note_{note_id}_{suffix}")
        };
        let candidate = retired_root.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    unreachable!("the retired-note suffix space is non-empty")
}

fn create_private_dir(path: &Path) -> Result<(), AuthError> {
    std::fs::create_dir_all(path).map_err(|err| AuthError::Wallet(err.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|err| AuthError::Wallet(err.to_string()))?;
    }
    Ok(())
}

fn prepared_withdrawal_path(state_dir: &Path) -> PathBuf {
    state_dir.join("prepared_withdrawal.json")
}

fn load_prepared_withdrawal(state_dir: &Path) -> Result<Option<WithdrawalPlan>, AuthError> {
    let path = prepared_withdrawal_path(state_dir);
    if !path.exists() {
        return Ok(None);
    }
    let encoded = std::fs::read(&path).map_err(|error| {
        AuthError::Wallet(format!("failed to read {}: {error}", path.display()))
    })?;
    serde_json::from_slice(&encoded).map(Some).map_err(|error| {
        AuthError::Wallet(format!(
            "prepared withdrawal state {} is invalid: {error}",
            path.display()
        ))
    })
}

fn persist_prepared_withdrawal(state_dir: &Path, plan: &WithdrawalPlan) -> Result<(), AuthError> {
    let path = prepared_withdrawal_path(state_dir);
    let temporary = state_dir.join("prepared_withdrawal.json.tmp");
    let encoded = serde_json::to_vec_pretty(plan)
        .map_err(|error| AuthError::Serialization(error.to_string()))?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| AuthError::Wallet(error.to_string()))?;
    use std::io::Write;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|error| AuthError::Wallet(error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| AuthError::Wallet(error.to_string()))?;
    }
    drop(file);
    std::fs::rename(&temporary, &path).map_err(|error| AuthError::Wallet(error.to_string()))
}

fn remove_prepared_withdrawal(state_dir: &Path) -> Result<(), AuthError> {
    let path = prepared_withdrawal_path(state_dir);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AuthError::Wallet(error.to_string())),
    }
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
        proof_mode: ClientProofMode::Groth16 {
            setup_dir: config.proof_setup_dir.clone(),
        },
        trusted_epoch_roots,
        state_signing_key: config.state_signing_key.clone(),
        clearance_signing_key: config.clearance_signing_key.clone(),
    }
}

/// Map the configured proof-mode name to the protocol's `ClientProofMode`.
fn load_wallet(
    config: &AuthConfig,
    trusted_epoch_roots: Vec<EpochRoots>,
) -> Result<Wallet, AuthError> {
    Wallet::new(client_config(config, trusted_epoch_roots)).map_err(Into::into)
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
mod security_tests {
    use std::time::Duration;

    use reqwest::StatusCode;

    use super::{
        abi_word_u64, abi_words, direct_remote_retry_delay, enforce_required_key_source,
        format_address, format_felt_address, is_exhausted_openrouter_key,
        is_rejected_openrouter_key, is_transient_remote_status, matches_trusted_url,
        normalize_session_id, validate_oa_key_evidence, OaKeyVerificationEvidence,
        MAX_OA_EVIDENCE_EXPIRY_SKEW_SECONDS, MAX_OA_SIGNATURE_ENCODING_LEN,
    };
    use crate::error::AuthError;
    use zkapi_types::Felt252;

    #[test]
    fn endpoint_pinning_rejects_inference_origin_substitution() {
        assert!(matches_trusted_url(
            "https://openrouter.ai/api/v1/",
            "https://openrouter.ai/api/v1"
        ));
        assert!(!matches_trusted_url(
            "https://attacker.example/api/v1",
            "https://openrouter.ai/api/v1"
        ));
        assert!(!matches_trusted_url(
            "http://openrouter.ai/api/v1",
            "https://openrouter.ai/api/v1"
        ));
    }

    #[test]
    fn required_oa_policy_rejects_direct_and_legacy_downgrades() {
        assert!(enforce_required_key_source(true, "openrouter").is_err());
        assert!(enforce_required_key_source(true, "").is_err());
        assert!(enforce_required_key_source(true, "oa_org").is_ok());
        assert!(enforce_required_key_source(false, "openrouter").is_ok());
    }

    #[test]
    fn direct_remote_retries_only_transient_statuses_and_honors_retry_after() {
        assert!(is_transient_remote_status(StatusCode::BAD_GATEWAY));
        assert!(is_transient_remote_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(is_transient_remote_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(!is_transient_remote_status(StatusCode::BAD_REQUEST));
        assert!(!is_transient_remote_status(StatusCode::UNAUTHORIZED));
        assert_eq!(
            direct_remote_retry_delay(1, Some(Duration::from_secs(60))),
            Duration::from_secs(60)
        );
    }
    #[test]
    fn bounded_key_replacement_is_narrow() {
        let unauthorized = AuthError::UpstreamResponse {
            status: StatusCode::UNAUTHORIZED,
            message: "invalid key".to_string(),
        };
        assert!(is_rejected_openrouter_key(&unauthorized));

        let key_limit = AuthError::UpstreamResponse {
            status: StatusCode::PAYMENT_REQUIRED,
            message: r#"{"error":{"metadata":{"limit_source":"openrouter_key_limit"}}}"#
                .to_string(),
        };
        assert!(!is_rejected_openrouter_key(&key_limit));
        assert!(is_exhausted_openrouter_key(&key_limit));

        let total_key_limit = AuthError::UpstreamResponse {
            status: StatusCode::FORBIDDEN,
            message: r#"{"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/216fb8653233c25e6e60bbf30158f3e74c474b2b584ac1bfd40e0adec6c80f8b","code":403}}"#.to_string(),
        };
        assert!(is_rejected_openrouter_key(&total_key_limit));

        let permission_denied = AuthError::UpstreamResponse {
            status: StatusCode::FORBIDDEN,
            message: r#"{"error":{"message":"Request blocked by guardrail","code":403}}"#
                .to_string(),
        };
        assert!(!is_rejected_openrouter_key(&permission_denied));
    }

    #[test]
    fn session_ids_are_bounded_and_header_safe() {
        assert_eq!(normalize_session_id(None).unwrap(), "default");
        assert_eq!(
            normalize_session_id(Some("chat:abc-123")).unwrap(),
            "chat:abc-123"
        );
        assert!(normalize_session_id(Some("")).is_err());
        assert!(normalize_session_id(Some("contains spaces")).is_err());
        assert!(normalize_session_id(Some(&"x".repeat(129))).is_err());
    }

    #[test]
    fn withdrawal_rpc_abi_helpers_are_strict() {
        let encoded = format!("0x{:064x}{:064x}", 1u64, u64::MAX);
        let words = abi_words(&encoded).unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(abi_word_u64(words[0]).unwrap(), 1);
        assert_eq!(abi_word_u64(words[1]).unwrap(), u64::MAX);
        assert!(abi_words("0x1234").is_err());
        assert!(abi_word_u64(&format!("1{:063x}", 0)).is_err());
    }

    #[test]
    fn withdrawal_addresses_are_canonical() {
        assert_eq!(
            format_address(&[0x22; 20]),
            "0x2222222222222222222222222222222222222222"
        );
        assert_eq!(
            format_felt_address(&Felt252::from_u64(0x1234)),
            "0x0000000000000000000000000000000000001234"
        );
    }

    #[test]
    fn oa_evidence_defers_signature_encoding_to_the_pinned_verifier() {
        let evidence = OaKeyVerificationEvidence {
            verifier_url: "https://verifier.example".to_string(),
            station_id: "station-1".to_string(),
            station_recently_attested: true,
            key_valid_till: 123,
            station_signature: "provider-specific-encoding".to_string(),
            org_signature: "another-provider-specific-encoding".to_string(),
        };

        assert!(validate_oa_key_evidence(123, &evidence).is_ok());
        assert!(validate_oa_key_evidence(124, &evidence).is_err());

        let mut bounded_skew = evidence.clone();
        bounded_skew.key_valid_till = 123 + MAX_OA_EVIDENCE_EXPIRY_SKEW_SECONDS;
        assert!(validate_oa_key_evidence(123, &bounded_skew).is_ok());
        bounded_skew.key_valid_till += 1;
        assert!(validate_oa_key_evidence(123, &bounded_skew).is_err());

        let mut missing = evidence.clone();
        missing.org_signature.clear();
        assert!(validate_oa_key_evidence(123, &missing).is_err());

        let mut oversized = evidence;
        oversized.station_signature = "x".repeat(MAX_OA_SIGNATURE_ENCODING_LEN + 1);
        assert!(validate_oa_key_evidence(123, &oversized).is_err());
    }
}

#[cfg(test)]
mod wallet_lifecycle_tests {
    use tempfile::tempdir;
    use zkapi_client::journal::PendingRequestJournal;
    use zkapi_client::note_state::NoteState;

    use super::*;

    async fn service_with_note(
        balance: u128,
        request_charge_cap: u128,
    ) -> (tempfile::TempDir, Arc<AuthService>) {
        let directory = tempdir().unwrap();
        let service = AuthService::new(AuthConfig {
            state_dir: directory.path().to_path_buf(),
            request_charge_cap,
            ..Default::default()
        })
        .unwrap();
        service
            .confirm_deposit(ConfirmDepositRequest {
                secret: Felt252::ONE,
                note_id: 18,
                amount: balance,
                expiry_ts: 4_000_000_000,
            })
            .await
            .unwrap();
        (directory, service)
    }

    #[tokio::test]
    async fn low_balance_note_is_preserved_and_active_slot_is_cleared() {
        let (directory, service) = service_with_note(50_000, 50_000).await;

        let retired = service
            .retire_low_balance_note()
            .await
            .unwrap()
            .expect("low-balance note should be retired");

        assert_eq!(retired.note_id, 18);
        assert_eq!(retired.remaining_balance, 50_000);
        assert_eq!(retired.state_dir, directory.path().join("retired/note_18"));
        assert!(!directory.path().join("note_state.json").exists());
        let preserved = NoteState::load(&retired.state_dir.join("note_state.json")).unwrap();
        assert_eq!(preserved.note_id, 18);
        assert_eq!(preserved.current_balance, 50_000);
        assert!(!service.status().await.unwrap().has_note);
    }

    #[tokio::test]
    async fn healthy_or_pending_note_is_never_retired() {
        let (_healthy_directory, healthy) = service_with_note(50_001, 50_000).await;
        assert!(healthy.retire_low_balance_note().await.unwrap().is_none());
        assert!(healthy.status().await.unwrap().has_note);

        let (pending_directory, pending) = service_with_note(50_000, 50_000).await;
        PendingRequestJournal::write(
            &pending_directory.path().join("pending_journal.json"),
            &PendingRequestJournal {
                exists: true,
                client_request_id: "pending-request".to_string(),
                nullifier: Felt252::ONE,
                payload_hash: Felt252::ONE,
                user_rerandomization: Felt252::ONE,
                created_at_ms: 1,
                prepared_request: None,
            },
        )
        .unwrap();

        assert!(matches!(
            pending.retire_low_balance_note().await,
            Err(AuthError::PendingRequest)
        ));
        assert!(pending_directory.path().join("note_state.json").exists());
        assert!(!pending_directory.path().join("retired").exists());
    }
}

#[cfg(any())]
mod tests {
    use std::sync::{Arc, RwLock};

    use axum::extract::{Path as AxumPath, State};
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;
    use tokio::net::TcpListener;
    use zkapi_core::leaf::{compute_note_leaf, compute_registration_commitment};
    use zkapi_core::merkle::MerkleTree;
    #[cfg(feature = "dev-witness-envelope")]
    use zkapi_core::poseidon::felt_to_field;
    #[cfg(feature = "dev-witness-envelope")]
    use zkapi_serverd::nullifier_store::NullifierStore;
    #[cfg(feature = "dev-witness-envelope")]
    use zkapi_serverd::processor::RequestProcessor;
    #[cfg(feature = "dev-witness-envelope")]
    use zkapi_serverd::provider::EchoProvider;
    #[cfg(feature = "dev-witness-envelope")]
    use zkapi_serverd::routes::create_router;
    #[cfg(feature = "dev-witness-envelope")]
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

    #[cfg(not(feature = "dev-witness-envelope"))]
    #[test]
    fn dev_witness_mode_requires_the_build_feature() {
        let result = AuthService::new(AuthConfig {
            proof_mode: "dev_witness_envelope".to_string(),
            state_dir: test_dir("dev_witness_feature_gate"),
            ..Default::default()
        });

        assert!(matches!(result, Err(AuthError::InvalidInput(message)) if
            message.contains("requires the dev-witness-envelope build feature")));
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

    #[cfg(feature = "dev-witness-envelope")]
    async fn protocol_server(root: Felt252, dir: &Path) -> (String, EpochRoots) {
        let store = Arc::new(NullifierStore::new(dir.join("server.db")).unwrap());
        let signer = Arc::new(ServerSigner::with_height(
            felt_to_field(&Felt252::from_u64(1)),
            felt_to_field(&Felt252::from_u64(2)),
            1,
            8,
        ));
        let trusted_roots = EpochRoots {
            epoch: 1,
            state_root: signer.state_root(),
            clear_root: signer.clear_root(),
        };
        let processor = Arc::new(RequestProcessor::new(
            zkapi_serverd::config::ServerConfig {
                contract_address: Felt252::from_u64(0xdeadbeef),
                chain_id: 1,
                protocol_version: 1,
                request_charge_cap: 100,
                policy_charge_cap: 100,
                initial_root: root,
                proof_mode: "dev_witness_envelope".to_string(),
                ..Default::default()
            },
            store,
            signer,
            Arc::new(EchoProvider::default()),
            root,
        ));
        (spawn_axum(create_router(processor)).await, trusted_roots)
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
            proof_mode: ClientProofMode::StwoScarb {
                cairo_dir: "protocol/cairo".to_string(),
            },
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
        // Default proof mode is production stwo_scarb -> label "stwo_cairo".
        assert_eq!(preview.runtime_proof_backend, "stwo_cairo");
        assert!(preview.request.path.contains("/v1/chat/completions"));
        assert!(!preview.payload_hash.is_zero());
        assert!(!preview.registration_commitment.is_zero());
        assert!(!preview.request_nullifier.is_zero());
    }

    #[cfg(feature = "dev-witness-envelope")]
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
        let (protocol_server_url, trusted_roots) = protocol_server(root, &state_dir).await;

        let service = AuthService::new(AuthConfig {
            protocol_server_url,
            indexer_url,
            state_dir: state_dir.clone(),
            request_charge_cap: 100,
            policy_charge_cap: 100,
            contract_address: Felt252::from_u64(0xdeadbeef),
            models: vec![ModelDescriptor::new("demo")],
            proof_mode: "dev_witness_envelope".to_string(),
            trusted_epoch_roots: vec![trusted_roots],
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
