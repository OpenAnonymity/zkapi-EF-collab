//! Server configuration.

use zkapi_types::Felt252;

/// Upstream provider implementation to use for request execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Echo,
    HttpProxy,
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
        }
    }
}
