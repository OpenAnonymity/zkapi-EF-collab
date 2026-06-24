use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand, ValueEnum};
use serde_json::Value;
use zkapi_client::config::{ClientConfig, ClientProofMode};
use zkapi_client::wallet::Wallet;
use zkapi_clientd::{
    run, AuthConfig, AuthService, ConfirmDepositRequest, CoreRequest, ModelDescriptor,
    WithdrawalMode,
};
use zkapi_serverd::config::{ProviderKind, ServerConfig};
use zkapi_types::Felt252;

#[derive(Debug, Parser)]
#[command(name = "zkapi", about = "App-layer CLI for zkAPI")]
struct Cli {
    #[arg(long, default_value = ".zkapi")]
    state_dir: PathBuf,
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
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Clone, Subcommand)]
enum Commands {
    Keygen,
    #[command(name = "clientd", alias = "auth", alias = "serve-auth")]
    Clientd {
        #[arg(long, default_value = "127.0.0.1:11434")]
        listen: String,
    },
    #[command(name = "serverd", alias = "server")]
    Serverd {
        #[arg(long, default_value = "127.0.0.1:3000")]
        listen: String,
        #[arg(long, value_enum, default_value_t = ProviderArg::Echo)]
        provider: ProviderArg,
        #[arg(long, default_value_t = 1)]
        flat_charge: u128,
        #[arg(long)]
        upstream_url: Option<String>,
        #[arg(long, default_value_t = 30_000)]
        proxy_timeout_ms: u64,
        #[arg(long, default_value = "zkapi-server.db")]
        db_path: String,
        #[arg(long, default_value = "0x1")]
        state_seed: String,
        #[arg(long, default_value = "0x2")]
        clear_seed: String,
        #[arg(long, default_value_t = 1)]
        epoch: u32,
        #[arg(long, default_value_t = zkapi_types::XMSS_TREE_HEIGHT)]
        xmss_height: usize,
        #[arg(long, default_value = "0x0")]
        initial_root: String,
        #[arg(long)]
        indexer_url: Option<String>,
        #[arg(long, default_value_t = 1_000)]
        root_poll_interval_ms: u64,
    },
    Indexer {
        #[arg(long, default_value = "127.0.0.1:3001")]
        listen: String,
        #[arg(long, default_value = "http://127.0.0.1:8545")]
        rpc_url: String,
        #[arg(long)]
        contract_address: String,
        #[arg(long, default_value_t = 0)]
        from_block: u64,
        #[arg(long, default_value_t = 1_000)]
        poll_interval_ms: u64,
        #[arg(long)]
        cursor_path: Option<String>,
    },
    Status,
    PrepareDeposit {
        #[arg(long)]
        amount: u128,
    },
    ConfirmDeposit {
        #[arg(long)]
        secret: String,
        #[arg(long)]
        note_id: u32,
        #[arg(long)]
        amount: u128,
        #[arg(long)]
        expiry_ts: u64,
    },
    Request {
        #[arg(long)]
        path: String,
        #[arg(long, default_value = "POST")]
        method: String,
        #[arg(long)]
        json: Option<String>,
        #[arg(long)]
        body_file: Option<PathBuf>,
    },
    Recover,
    Withdraw {
        #[arg(long)]
        destination: String,
        #[arg(long, value_enum, default_value_t = WithdrawalModeArg::Mutual)]
        mode: WithdrawalModeArg,
    },
}

#[derive(Debug, Clone, ValueEnum)]
enum WithdrawalModeArg {
    Mutual,
    Escape,
}

#[derive(Debug, Clone, ValueEnum)]
enum ProviderArg {
    Echo,
    HttpProxy,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();

    match cli.command.clone() {
        Commands::Keygen => {
            let wallet = Wallet::new(client_config(&cli)?)
                .map_err(|err| anyhow::anyhow!("failed to create wallet: {err}"))?;
            let (secret, commitment) = wallet.generate_deposit_params();
            print_json(&serde_json::json!({
                "secret": secret,
                "commitment": commitment,
            }))?;
        }
        Commands::Clientd { listen } => {
            let service = build_auth_service(&cli)?;
            run(service, &listen).await?
        }
        Commands::Serverd {
            listen,
            provider,
            flat_charge,
            upstream_url,
            proxy_timeout_ms,
            db_path,
            state_seed,
            clear_seed,
            epoch,
            xmss_height,
            initial_root,
            indexer_url,
            root_poll_interval_ms,
        } => {
            let config = ServerConfig {
                protocol_version: cli.protocol_version,
                chain_id: cli.chain_id,
                contract_address: parse_felt("contract address", &cli.contract_address)?,
                request_charge_cap: cli.request_charge_cap,
                policy_charge_cap: cli.policy_charge_cap,
                policy_enabled: cli.policy_enabled,
                auth_scheme: parse_auth_scheme(&cli.auth_scheme)?,
                listen_addr: listen,
                provider_kind: match provider {
                    ProviderArg::Echo => ProviderKind::Echo,
                    ProviderArg::HttpProxy => ProviderKind::HttpProxy,
                },
                echo_fixed_charge: flat_charge,
                proxy_default_charge: flat_charge,
                proxy_upstream_url: upstream_url,
                proxy_timeout_ms,
                db_path,
                state_seed: parse_felt("state seed", &state_seed)?,
                clear_seed: parse_felt("clear seed", &clear_seed)?,
                epoch,
                xmss_height,
                initial_root: parse_felt("initial root", &initial_root)?,
                indexer_url,
                root_poll_interval_ms,
                ..Default::default()
            };
            zkapi_serverd::routes::run_server(config).await?;
        }
        Commands::Indexer {
            listen,
            rpc_url,
            contract_address,
            from_block,
            poll_interval_ms,
            cursor_path,
        } => {
            let config = zkapi_indexerd::IndexerConfig {
                listen_addr: listen,
                rpc_url,
                contract_address,
                from_block,
                poll_interval_ms,
                cursor_path,
            };
            zkapi_indexerd::run_indexer(config).await?;
        }
        Commands::Status => {
            let service = build_auth_service(&cli)?;
            print_json(&service.status().await?)?
        }
        Commands::PrepareDeposit { amount } => {
            let service = build_auth_service(&cli)?;
            print_json(&service.prepare_deposit(amount).await?)?
        }
        Commands::ConfirmDeposit {
            secret,
            note_id,
            amount,
            expiry_ts,
        } => {
            let service = build_auth_service(&cli)?;
            let secret = Felt252::from_hex(&secret)
                .map_err(|err| anyhow::anyhow!("invalid --secret: {err}"))?;
            let result = service
                .confirm_deposit(ConfirmDepositRequest {
                    secret,
                    note_id,
                    amount,
                    expiry_ts,
                })
                .await?;
            print_json(&result)?;
        }
        Commands::Request {
            path,
            method,
            json,
            body_file,
        } => {
            let service = build_auth_service(&cli)?;
            let body = request_body(json, body_file)?;
            let result = service
                .execute_request(CoreRequest {
                    method,
                    path,
                    headers: Default::default(),
                    body,
                })
                .await?;
            print_json(&result)?;
        }
        Commands::Recover => {
            let service = build_auth_service(&cli)?;
            print_json(&service.recover().await?)?
        }
        Commands::Withdraw { destination, mode } => {
            let service = build_auth_service(&cli)?;
            let result = service
                .create_withdrawal(mode.into(), parse_destination(&destination)?)
                .await?;
            print_json(&result)?;
        }
    }

    Ok(())
}

fn build_auth_service(cli: &Cli) -> anyhow::Result<Arc<AuthService>> {
    AuthService::new(AuthConfig {
        protocol_version: cli.protocol_version,
        chain_id: cli.chain_id,
        contract_address: parse_felt("contract address", &cli.contract_address)?,
        request_charge_cap: cli.request_charge_cap,
        policy_charge_cap: cli.policy_charge_cap,
        policy_enabled: cli.policy_enabled,
        auth_scheme: parse_auth_scheme(&cli.auth_scheme)?,
        protocol_server_url: cli.protocol_server_url.clone(),
        indexer_url: cli.indexer_url.clone(),
        listen_addr: "127.0.0.1:11434".to_string(),
        state_dir: cli.state_dir.clone(),
        models: cli
            .models
            .iter()
            .cloned()
            .map(ModelDescriptor::new)
            .collect(),
        demo_rpc_url: cli.demo_rpc_url.clone(),
        demo_billing_token_address: cli.demo_billing_token_address.clone(),
        demo_private_key: cli.demo_private_key.clone(),
        demo_note_ttl_seconds: cli.demo_note_ttl_seconds,
    })
    .map_err(Into::into)
}

fn client_config(cli: &Cli) -> anyhow::Result<ClientConfig> {
    Ok(ClientConfig {
        protocol_version: cli.protocol_version,
        chain_id: cli.chain_id,
        contract_address: parse_felt("contract address", &cli.contract_address)?,
        request_charge_cap: cli.request_charge_cap,
        policy_charge_cap: cli.policy_charge_cap,
        policy_enabled: cli.policy_enabled,
        server_url: cli.protocol_server_url.clone(),
        state_dir: cli.state_dir.display().to_string(),
        // CLI `client_config` only backs the local-only `keygen` command; the
        // daemon path (build_auth_service) populates trusted roots per request.
        proof_mode: ClientProofMode::DevWitnessEnvelope,
        trusted_epoch_roots: Vec::new(),
    })
}

fn request_body(json: Option<String>, body_file: Option<PathBuf>) -> anyhow::Result<Value> {
    if let Some(json) = json {
        return Ok(serde_json::from_str(&json)?);
    }
    if let Some(path) = body_file {
        return Ok(serde_json::from_slice(&std::fs::read(path)?)?);
    }
    Ok(serde_json::json!({}))
}

fn parse_felt(label: &str, value: &str) -> anyhow::Result<Felt252> {
    Felt252::from_hex(value).map_err(|err| anyhow::anyhow!("invalid {label}: {err}"))
}

fn parse_auth_scheme(value: &str) -> anyhow::Result<zkapi_auth::AuthSchemeKind> {
    value.parse().map_err(|err: String| anyhow::anyhow!(err))
}

fn parse_destination(value: &str) -> anyhow::Result<[u8; 20]> {
    let hex = value.strip_prefix("0x").unwrap_or(value);
    if hex.len() != 40 {
        anyhow::bail!("destination must be a 20-byte hex address");
    }
    let mut bytes = [0u8; 20];
    for (idx, chunk) in hex.as_bytes().chunks(2).enumerate() {
        bytes[idx] = u8::from_str_radix(std::str::from_utf8(chunk)?, 16)?;
    }
    Ok(bytes)
}

fn print_json<T: serde::Serialize>(value: &T) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

impl From<WithdrawalModeArg> for WithdrawalMode {
    fn from(value: WithdrawalModeArg) -> Self {
        match value {
            WithdrawalModeArg::Mutual => WithdrawalMode::Mutual,
            WithdrawalModeArg::Escape => WithdrawalMode::Escape,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_parses_auth_command_with_global_options() {
        let cli = Cli::try_parse_from([
            "zkapi",
            "--state-dir",
            "/tmp/demo-wallet",
            "--protocol-server-url",
            "http://127.0.0.1:3999",
            "--indexer-url",
            "http://127.0.0.1:3998",
            "--contract-address",
            "0x1234",
            "--model",
            "gpt-proxy",
            "clientd",
            "--listen",
            "127.0.0.1:11435",
        ])
        .expect("cli parse");

        assert_eq!(cli.state_dir, PathBuf::from("/tmp/demo-wallet"));
        assert_eq!(cli.protocol_server_url, "http://127.0.0.1:3999");
        assert_eq!(cli.indexer_url, "http://127.0.0.1:3998");
        assert_eq!(cli.models, vec!["gpt-proxy".to_string()]);

        match cli.command {
            Commands::Clientd { listen } => assert_eq!(listen, "127.0.0.1:11435"),
            other => panic!("expected clientd command, got {other:?}"),
        }
    }

    #[test]
    fn cli_parses_server_and_indexer_subcommands() {
        let server = Cli::try_parse_from([
            "zkapi",
            "--contract-address",
            "0xdeadbeef",
            "serverd",
            "--provider",
            "http-proxy",
            "--upstream-url",
            "http://127.0.0.1:8080/upstream",
            "--indexer-url",
            "http://127.0.0.1:3001",
            "--db-path",
            "demo.db",
        ])
        .expect("server parse");
        match server.command {
            Commands::Serverd {
                provider,
                upstream_url,
                indexer_url,
                db_path,
                ..
            } => {
                assert!(matches!(provider, ProviderArg::HttpProxy));
                assert_eq!(
                    upstream_url.as_deref(),
                    Some("http://127.0.0.1:8080/upstream")
                );
                assert_eq!(indexer_url.as_deref(), Some("http://127.0.0.1:3001"));
                assert_eq!(db_path, "demo.db");
            }
            other => panic!("expected server command, got {other:?}"),
        }

        let indexer = Cli::try_parse_from([
            "zkapi",
            "--contract-address",
            "0xdeadbeef",
            "indexer",
            "--contract-address",
            "0xfeedface",
            "--cursor-path",
            "indexer.cursor",
        ])
        .expect("indexer parse");
        match indexer.command {
            Commands::Indexer {
                contract_address,
                cursor_path,
                ..
            } => {
                assert_eq!(contract_address, "0xfeedface");
                assert_eq!(cursor_path.as_deref(), Some("indexer.cursor"));
            }
            other => panic!("expected indexer command, got {other:?}"),
        }
    }

    #[test]
    fn parse_destination_accepts_prefixed_and_bare_hex() {
        let prefixed = parse_destination("0x1111111111111111111111111111111111111111").unwrap();
        let bare = parse_destination("2222222222222222222222222222222222222222").unwrap();

        assert_eq!(prefixed, [0x11; 20]);
        assert_eq!(bare, [0x22; 20]);
        assert!(parse_destination("0x1234").is_err());
    }
}
