use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use zkapi_types::Felt252;

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
    pub protocol_server_url: String,
    pub indexer_url: String,
    pub listen_addr: String,
    pub state_dir: PathBuf,
    pub models: Vec<ModelDescriptor>,
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
            protocol_server_url: "http://127.0.0.1:3000".to_string(),
            indexer_url: "http://127.0.0.1:3001".to_string(),
            listen_addr: "127.0.0.1:11434".to_string(),
            state_dir: PathBuf::from(".zkapi"),
            models: vec![ModelDescriptor::new("zkapi-echo")],
        }
    }
}
