use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use zkapi_types::{EpochRoots, Felt252};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelDescriptor {
    pub id: String,
    pub owned_by: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

impl ModelDescriptor {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            owned_by: "zkapi".to_string(),
            tags: vec!["chat".to_string(), "responses".to_string()],
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub protocol_version: u16,
    pub chain_id: u64,
    pub contract_address: Felt252,
    pub request_charge_cap: u128,
    pub policy_charge_cap: u128,
    pub policy_enabled: bool,
    /// Authentication method this client uses; must match the server's.
    pub auth_scheme: zkapi_auth::AuthSchemeKind,
    pub protocol_server_url: String,
    pub indexer_url: String,
    pub listen_addr: String,
    pub state_dir: PathBuf,
    pub models: Vec<ModelDescriptor>,
    pub demo_rpc_url: Option<String>,
    pub demo_billing_token_address: Option<String>,
    pub demo_private_key: Option<String>,
    pub demo_note_ttl_seconds: Option<u64>,
    /// Proof backend the wallet uses: "stwo_scarb" (production, real STARK) or
    /// "dev_witness_envelope" (dev-only witness replay; must be selected
    /// explicitly). Defaults to production.
    pub proof_mode: String,
    /// Cairo package dir for real Stwo proving (used when proof_mode=stwo_scarb).
    pub cairo_dir: String,
    /// On-chain-verified server signing roots trusted by this client.
    pub trusted_epoch_roots: Vec<EpochRoots>,
}

impl AuthConfig {
    /// Wire label for the configured proof backend.
    pub fn proof_backend_label(&self) -> &'static str {
        match self.proof_mode.as_str() {
            "dev_witness_envelope" => "dev_witness_envelope",
            _ => "stwo_cairo",
        }
    }
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            protocol_version: 1,
            chain_id: 1,
            contract_address: Felt252::ZERO,
            request_charge_cap: 1_000_000,
            policy_charge_cap: 10_000_000,
            policy_enabled: false,
            auth_scheme: zkapi_auth::AuthSchemeKind::StateAnchor,
            protocol_server_url: "http://127.0.0.1:3000".to_string(),
            indexer_url: "http://127.0.0.1:3001".to_string(),
            listen_addr: "127.0.0.1:11434".to_string(),
            state_dir: PathBuf::from(".zkapi"),
            models: vec![ModelDescriptor::new("zkapi-echo")],
            demo_rpc_url: None,
            demo_billing_token_address: None,
            demo_private_key: None,
            demo_note_ttl_seconds: None,
            proof_mode: "stwo_scarb".to_string(),
            cairo_dir: "protocol/cairo".to_string(),
            trusted_epoch_roots: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_backend_label_maps_modes() {
        // Production default.
        assert_eq!(AuthConfig::default().proof_backend_label(), "stwo_cairo");
        let dev = AuthConfig {
            proof_mode: "dev_witness_envelope".to_string(),
            ..Default::default()
        };
        assert_eq!(dev.proof_backend_label(), "dev_witness_envelope");
        let stwo = AuthConfig {
            proof_mode: "stwo_scarb".to_string(),
            ..Default::default()
        };
        assert_eq!(stwo.proof_backend_label(), "stwo_cairo");
    }
}
