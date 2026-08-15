use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use zkapi_types::wire::CurvePointWire;
use zkapi_types::{EpochRoots, Felt252};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RequestMode {
    /// The zkAPI server forwards each LLM request to its configured provider.
    #[default]
    Proxy,
    /// The local daemon leases bounded OpenRouter keys and sends prompts
    /// directly; the zkAPI server sees only lease settlement.
    DirectOpenrouter,
}

pub const DEFAULT_OPENROUTER_REQUESTS_PER_KEY: u32 = 5;

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
    /// Retired v1 compatibility field; v2 always uses Groth16 BN254.
    pub proof_mode: String,
    /// Retired v1 compatibility field; ignored by the v2 wallet.
    pub cairo_dir: String,
    /// On-chain-verified server signing roots trusted by this client.
    pub trusted_epoch_roots: Vec<EpochRoots>,
    /// Circuit-specific Groth16 key directory.
    pub proof_setup_dir: String,
    /// Deployment-pinned proof-friendly signing keys.
    pub state_signing_key: CurvePointWire,
    pub clearance_signing_key: CurvePointWire,
    pub request_mode: RequestMode,
    /// Independently configured OA verifier trust anchor. Verifier URLs
    /// supplied by a zkAPI server must match this value exactly.
    pub oa_verifier_url: String,
    /// Independently configured inference origin. Lease responses must match
    /// this value exactly before a child key or prompt is transmitted.
    pub openrouter_inference_base: String,
    /// Reject direct/legacy OpenRouter leases and require verifier-backed OA
    /// org evidence. This is an independent anti-downgrade policy.
    pub require_oa_org_key_source: bool,
    /// Maximum local LLM requests sent with one ephemeral key. A lower value
    /// reduces cross-request linkability at the cost of more lease proofs and
    /// settlement pauses.
    pub openrouter_requests_per_key: u32,
}

impl AuthConfig {
    /// Wire label for the configured proof backend.
    pub fn proof_backend_label(&self) -> &'static str {
        "groth16_bn254"
    }
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            protocol_version: 2,
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
            proof_mode: "groth16_bn254".to_string(),
            cairo_dir: "protocol/cairo".to_string(),
            trusted_epoch_roots: Vec::new(),
            proof_setup_dir: "protocol/setup/v2".to_string(),
            state_signing_key: CurvePointWire {
                x: Felt252::ZERO,
                y: Felt252::ONE,
            },
            clearance_signing_key: CurvePointWire {
                x: Felt252::ZERO,
                y: Felt252::ONE,
            },
            request_mode: RequestMode::Proxy,
            oa_verifier_url: "https://verifier2.openanonymity.ai".to_string(),
            openrouter_inference_base: "https://openrouter.ai/api/v1".to_string(),
            require_oa_org_key_source: false,
            openrouter_requests_per_key: DEFAULT_OPENROUTER_REQUESTS_PER_KEY,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_backend_label_maps_modes() {
        // Production default.
        assert_eq!(AuthConfig::default().proof_backend_label(), "groth16_bn254");
        let dev = AuthConfig {
            proof_mode: "dev_witness_envelope".to_string(),
            ..Default::default()
        };
        assert_eq!(dev.proof_backend_label(), "groth16_bn254");
        let stwo = AuthConfig {
            proof_mode: "stwo_scarb".to_string(),
            ..Default::default()
        };
        assert_eq!(stwo.proof_backend_label(), "groth16_bn254");
    }
}
