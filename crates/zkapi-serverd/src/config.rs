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
#[derive(Clone)]
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

impl std::fmt::Debug for MeteredConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MeteredConfig")
            .field("openai_api_base", &self.openai_api_base)
            .field(
                "openai_api_key",
                &self.openai_api_key.as_ref().map(|_| "[configured]"),
            )
            .field("openrouter_api_base", &self.openrouter_api_base)
            .field(
                "openrouter_inference_key",
                &self
                    .openrouter_inference_key
                    .as_ref()
                    .map(|_| "[configured]"),
            )
            .finish()
    }
}

/// Source used to provision prompt-private, short-lived OpenRouter keys.
#[derive(Clone)]
pub enum OpenRouterLeaseSourceConfig {
    /// Mint child keys directly with an OpenRouter management key.
    OpenRouter {
        management_key: String,
        /// OpenRouter API base without `/v1`.
        api_base: String,
    },
    /// Ask an OA org to relay key creation to a verifier-enrolled station.
    OaOrg {
        org_base_url: String,
        /// Dedicated zkAPI service credential configured by the org.
        shared_secret: String,
    },
}

impl OpenRouterLeaseSourceConfig {
    pub fn label(&self) -> &'static str {
        match self {
            Self::OpenRouter { .. } => "openrouter",
            Self::OaOrg { .. } => "oa_org",
        }
    }
}

impl std::fmt::Debug for OpenRouterLeaseSourceConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OpenRouter { api_base, .. } => formatter
                .debug_struct("OpenRouter")
                .field("management_key", &"[configured]")
                .field("api_base", api_base)
                .finish(),
            Self::OaOrg { org_base_url, .. } => formatter
                .debug_struct("OaOrg")
                .field("org_base_url", org_base_url)
                .field("shared_secret", &"[configured]")
                .finish(),
        }
    }
}

/// Prompt-private lease configuration. This remains independent from the
/// metered pass-through provider, so both modes can be exposed together.
#[derive(Debug, Clone)]
pub struct OpenRouterLeaseConfig {
    pub source: OpenRouterLeaseSourceConfig,
    /// Runtime-key validity window.
    pub ttl_seconds: u64,
    /// Delay after key expiry before reading aggregate usage, allowing the
    /// provider's usage counters to become consistent.
    pub settlement_grace_seconds: u64,
    /// Background settlement scan interval.
    pub settlement_poll_seconds: u64,
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
    /// Protocol version (must be 2).
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
    /// Seed for the proof-friendly state-signing key.
    pub state_seed: Felt252,
    /// Seed for the proof-friendly clearance-signing key.
    pub clear_seed: Felt252,
    /// Retired v1 compatibility field; ignored by the v2 processor.
    pub epoch: u32,
    /// Retired v1 compatibility field; ignored by the v2 processor.
    pub xmss_height: usize,
    /// Initial Merkle root the server should accept until the indexer updates it.
    pub initial_root: Felt252,
    /// Optional base URL for an indexer that serves the latest tree root.
    pub indexer_url: Option<String>,
    /// Poll interval for indexer root refresh.
    pub root_poll_interval_ms: u64,
    /// Retired v1 compatibility field; ignored by the v2 processor.
    pub trusted_epoch_roots: Vec<EpochRoots>,
    /// Configuration for the metered upstream provider (when
    /// `provider_kind == Metered`).
    pub metered: Option<MeteredConfig>,
    /// Prompt-private OpenRouter lease mode. `None` disables only this mode;
    /// ordinary provider proxying remains available.
    pub openrouter_leases: Option<OpenRouterLeaseConfig>,
    /// Retired v1 compatibility field; v2 always uses Groth16 BN254.
    pub proof_mode: String,
    /// Retired v1 compatibility field; ignored by the v2 processor.
    pub cairo_dir: String,
    /// Directory containing the v2 Groth16 proving/verifying key files.
    pub proof_setup_dir: String,
}

impl ServerConfig {
    /// Wire label for the configured proof backend.
    pub fn proof_backend_label(&self) -> &'static str {
        "groth16_bn254"
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            protocol_version: 2,
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
            openrouter_leases: None,
            proof_mode: "groth16_bn254".to_string(),
            cairo_dir: "protocol/cairo".to_string(),
            proof_setup_dir: "protocol/setup/v2".to_string(),
        }
    }
}
