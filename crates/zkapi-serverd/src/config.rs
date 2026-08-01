//! Server configuration.

use zkapi_types::{EpochRoots, Felt252};

/// Upstream provider implementation to use for request execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Echo,
    HttpProxy,
    /// Token-usage-metered upstream (OpenAI / OpenRouter) with real billing.
    Metered,
}

/// Which upstream API flavor the metered provider talks to. Determines how
/// cost is derived (OpenRouter self-reports `usage.cost`; OpenAI is priced
/// from the built-in table) and how requests are shaped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamKind {
    OpenAi,
    OpenRouter,
}

impl UpstreamKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            UpstreamKind::OpenAi => "openai",
            UpstreamKind::OpenRouter => "openrouter",
        }
    }
}

/// Configuration for the token-usage-metered provider.
///
/// Both upstreams can be configured at once — there is no single "upstream
/// kind". A pass-through request is routed by its model id: a vendor-prefixed id
/// (`openai/…`, `anthropic/…`) goes to OpenRouter (billed at the provider's
/// exact reported cost), a bare id (`gpt-4o-mini`) goes to OpenAI (billed from
/// the built-in price table).
#[derive(Debug, Clone)]
pub struct MeteredConfig {
    /// Base URL for OpenAI pass-through (`https://api.openai.com`).
    pub openai_api_base: String,
    /// OpenAI API key for pass-through inference. Absent => OpenAI models error.
    pub openai_api_key: Option<String>,
    /// OpenRouter base for pass-through (`https://openrouter.ai/api`).
    pub openrouter_api_base: String,
    /// OpenRouter API key for server-side pass-through inference.
    pub openrouter_inference_key: Option<String>,
}

impl Default for MeteredConfig {
    fn default() -> Self {
        Self {
            openai_api_base: "https://api.openai.com".to_string(),
            openai_api_key: None,
            openrouter_api_base: "https://openrouter.ai/api".to_string(),
            openrouter_inference_key: None,
        }
    }
}

impl MeteredConfig {
    /// Human-readable summary of which upstreams are configured.
    pub fn upstreams_label(&self) -> String {
        let mut parts = Vec::new();
        if self.openai_api_key.is_some() {
            parts.push("openai");
        }
        if self.openrouter_inference_key.is_some() {
            parts.push("openrouter");
        }
        if parts.is_empty() {
            "none".to_string()
        } else {
            parts.join("+")
        }
    }
}

/// Configuration for the zkAPI server.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// Protocol version (must be 1 for v1).
    pub protocol_version: u16,
    /// Chain ID this server is bound to.
    pub chain_id: u64,
    /// On-chain contract address.
    pub contract_address: Felt252,
    /// Maximum charge per request (in base units).
    pub request_charge_cap: u128,
    /// Maximum charge under policy enforcement.
    pub policy_charge_cap: u128,
    /// Whether policy enforcement is enabled.
    pub policy_enabled: bool,
    /// Authentication method this server runs; clients must match.
    pub auth_scheme: zkapi_auth::AuthSchemeKind,
    /// HTTP listen address (e.g. "0.0.0.0:3000").
    pub listen_addr: String,
    /// Provider backend used for request execution.
    pub provider_kind: ProviderKind,
    /// Fixed charge used by the echo provider.
    pub echo_fixed_charge: u128,
    /// Flat fallback charge used by the HTTP proxy provider.
    pub proxy_default_charge: u128,
    /// Upstream base URL for the HTTP proxy provider.
    pub proxy_upstream_url: Option<String>,
    /// Timeout for proxied upstream requests.
    pub proxy_timeout_ms: u64,
    /// Path to the SQLite database file.
    pub db_path: String,
    /// Timeout in milliseconds for recovery of reserved-but-unfinalized entries.
    pub recovery_timeout_ms: u64,
    /// Seed for the state-signing XMSS tree.
    pub state_seed: Felt252,
    /// Seed for the clearance-signing XMSS tree.
    pub clear_seed: Felt252,
    /// Published XMSS epoch served by this process.
    pub epoch: u32,
    /// XMSS tree height.
    pub xmss_height: usize,
    /// Initial Merkle root the server should accept until the indexer updates it.
    pub initial_root: Felt252,
    /// Optional base URL for an indexer that serves the latest tree root.
    pub indexer_url: Option<String>,
    /// Poll interval for indexer root refresh.
    pub root_poll_interval_ms: u64,
    /// Previously published signing roots accepted for non-current epochs.
    pub trusted_epoch_roots: Vec<EpochRoots>,
    /// Configuration for the metered upstream provider (when
    /// `provider_kind == Metered`).
    pub metered: Option<MeteredConfig>,
    /// Proof verifier backend: "stwo_scarb" (production, real STARK) or
    /// "dev_witness_envelope" (dev-only witness replay; explicit opt-in).
    pub proof_mode: String,
    /// Cairo package dir for real Stwo verification (proof_mode=stwo_scarb).
    pub cairo_dir: String,
}

impl ServerConfig {
    /// Wire label for the configured proof backend.
    pub fn proof_backend_label(&self) -> &'static str {
        match self.proof_mode.as_str() {
            "dev_witness_envelope" => "dev_witness_envelope",
            _ => "stwo_cairo",
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            protocol_version: 1,
            chain_id: 1,
            contract_address: Felt252::ZERO,
            request_charge_cap: 1_000_000,
            policy_charge_cap: 10_000_000,
            policy_enabled: false,
            auth_scheme: zkapi_auth::AuthSchemeKind::StateAnchor,
            listen_addr: "0.0.0.0:3000".to_string(),
            provider_kind: ProviderKind::Echo,
            echo_fixed_charge: 1,
            proxy_default_charge: 1,
            proxy_upstream_url: None,
            proxy_timeout_ms: 30_000,
            db_path: "zkapi_server.db".to_string(),
            recovery_timeout_ms: 30_000,
            state_seed: Felt252::from_u64(1),
            clear_seed: Felt252::from_u64(2),
            epoch: 1,
            xmss_height: zkapi_types::XMSS_TREE_HEIGHT,
            initial_root: Felt252::ZERO,
            indexer_url: None,
            root_poll_interval_ms: 1_000,
            trusted_epoch_roots: Vec::new(),
            metered: None,
            proof_mode: "stwo_scarb".to_string(),
            cairo_dir: "protocol/cairo".to_string(),
        }
    }
}
