use clap::Parser;
use zkapi_auth::{run, AuthConfig, AuthService, ModelDescriptor};
use zkapi_types::Felt252;

#[derive(Debug, Parser)]
#[command(name = "zkapi-authd", about = "Local auth daemon for zkAPI wallets")]
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
    #[arg(long = "model", default_values_t = vec!["zkapi-echo".to_string()])]
    models: Vec<String>,
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
        protocol_server_url: args.protocol_server_url,
        indexer_url: args.indexer_url,
        listen_addr: args.listen.clone(),
        state_dir: args.state_dir,
        models: args.models.into_iter().map(ModelDescriptor::new).collect(),
    })?;

    run(service, &args.listen).await
}
