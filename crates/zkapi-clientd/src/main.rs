//! Entry point for `zkapi-clientd`, the local client daemon for zkAPI wallets.
//!
//! Parses CLI flags (listen address, state directory, serverd/indexer URLs,
//! protocol parameters, advertised models, and demo settings), builds an
//! [`AuthService`], and serves the HTTP API on the configured address.

use clap::Parser;
use zkapi_clientd::{run, AuthConfig, AuthService, ModelDescriptor};
use zkapi_types::Felt252;

#[derive(Debug, Parser)]
#[command(
    name = "zkapi-clientd",
    about = "Local client daemon for zkAPI wallets"
)]
struct Args {
    #[arg(long, default_value = "127.0.0.1:11434")]
    listen: String,
    #[arg(long, default_value = ".zkapi")]
    state_dir: std::path::PathBuf,
    #[arg(long, default_value = "http://127.0.0.1:3000")]
    protocol_server_url: String,
    #[arg(long, default_value = "http://127.0.0.1:3001")]
    indexer_url: String,
    #[arg(long, default_value_t = 1)]
    protocol_version: u16,
    #[arg(long, default_value_t = 1)]
    chain_id: u64,
    #[arg(long, default_value = "0x0")]
    contract_address: String,
    #[arg(long, default_value_t = 1_000_000)]
    request_charge_cap: u128,
    #[arg(long, default_value_t = 10_000_000)]
    policy_charge_cap: u128,
    #[arg(long, default_value_t = false)]
    policy_enabled: bool,
    /// Authentication method: `state-anchor` (default) or `blind-signature`.
    #[arg(long, default_value = "state-anchor")]
    auth_scheme: String,
    #[arg(long = "model", default_values_t = vec!["zkapi-echo".to_string()])]
    models: Vec<String>,
    #[arg(long)]
    demo_rpc_url: Option<String>,
    #[arg(long)]
    demo_billing_token_address: Option<String>,
    #[arg(long)]
    demo_private_key: Option<String>,
    #[arg(long)]
    demo_note_ttl_seconds: Option<u64>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args = Args::parse();
    let service = AuthService::new(AuthConfig {
        protocol_version: args.protocol_version,
        chain_id: args.chain_id,
        contract_address: Felt252::from_hex(&args.contract_address)
            .map_err(|err| anyhow::anyhow!("invalid --contract-address: {err}"))?,
        request_charge_cap: args.request_charge_cap,
        policy_charge_cap: args.policy_charge_cap,
        policy_enabled: args.policy_enabled,
        auth_scheme: args
            .auth_scheme
            .parse()
            .map_err(|err: String| anyhow::anyhow!(err))?,
        protocol_server_url: args.protocol_server_url,
        indexer_url: args.indexer_url,
        listen_addr: args.listen.clone(),
        state_dir: args.state_dir,
        models: args.models.into_iter().map(ModelDescriptor::new).collect(),
        demo_rpc_url: args.demo_rpc_url,
        demo_billing_token_address: args.demo_billing_token_address,
        demo_private_key: args.demo_private_key,
        demo_note_ttl_seconds: args.demo_note_ttl_seconds,
    })?;

    run(service, &args.listen).await
}
