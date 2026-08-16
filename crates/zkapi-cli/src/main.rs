use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use clap::{Parser, Subcommand, ValueEnum};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use serde_json::Value;
use zeroize::Zeroizing;
use zkapi_client::config::{ClientConfig, ClientProofMode};
use zkapi_client::wallet::Wallet;
use zkapi_clientd::{
    run, AuthConfig, AuthService, ConfirmDepositRequest, CoreRequest, FundingConfig,
    ModelDescriptor, RequestMode, WalletStatus, WithdrawalMode, WithdrawalPlan,
};
use zkapi_serverd::config::{
    MeteredConfig, OpenRouterLeaseConfig, OpenRouterLeaseSourceConfig, ProviderKind, ServerConfig,
};
use zkapi_types::wire::{CurvePointWire, ProofBackendWire};
use zkapi_types::{EpochRoots, Felt252};

const PUBLIC_MAINNET_MANIFEST: &str = "https://d27v1dvkaxfc09.cloudfront.net/config.json";

#[derive(Debug, Parser)]
#[command(name = "zkapi", about = "App-layer CLI for zkAPI")]
struct Cli {
    #[arg(long, default_value = ".zkapi")]
    state_dir: PathBuf,
    #[arg(long, default_value = "http://127.0.0.1:3000")]
    protocol_server_url: String,
    #[arg(long, default_value = "http://127.0.0.1:3001")]
    indexer_url: String,
    #[arg(long, default_value_t = 2)]
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
    demo_note_ttl_seconds: Option<u64>,
    /// JSON file containing an array of on-chain-verified epoch root records.
    #[arg(long, value_name = "JSON_PATH")]
    trusted_epoch_roots: Option<PathBuf>,
    #[arg(
        long,
        env = "ZKAPI_PROOF_SETUP_DIR",
        default_value = "protocol/setup/v2"
    )]
    proof_setup_dir: String,
    #[arg(long, env = "ZKAPI_STATE_SIGNING_KEY_X", default_value = "0x0")]
    state_signing_key_x: String,
    #[arg(long, env = "ZKAPI_STATE_SIGNING_KEY_Y", default_value = "0x1")]
    state_signing_key_y: String,
    #[arg(long, env = "ZKAPI_CLEARANCE_SIGNING_KEY_X", default_value = "0x0")]
    clearance_signing_key_x: String,
    #[arg(long, env = "ZKAPI_CLEARANCE_SIGNING_KEY_Y", default_value = "0x1")]
    clearance_signing_key_y: String,
    /// Trusted OA verifier used for station-issued key validation.
    #[arg(
        long,
        env = "ZKAPI_OA_VERIFIER_URL",
        default_value = "https://verifier2.openanonymity.ai"
    )]
    oa_verifier_url: String,
    /// Trusted OpenRouter inference origin for prompt-private leases.
    #[arg(
        long,
        env = "ZKAPI_OPENROUTER_INFERENCE_BASE",
        default_value = "https://openrouter.ai/api/v1"
    )]
    openrouter_inference_base: String,
    /// Require verifier-backed OA-org keys and reject direct/legacy leases.
    #[arg(long, env = "ZKAPI_REQUIRE_OA_ORG_KEY_SOURCE", default_value_t = false)]
    require_oa_org_key_source: bool,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Clone, Subcommand)]
// This value is constructed once at startup; boxing Clap fields would only
// complicate argument handling without improving the long-lived runtime.
#[allow(clippy::large_enum_variant)]
enum Commands {
    /// Generate the circuit-specific Groth16 proving and verification keys.
    Setup {
        #[arg(long, default_value = "protocol/setup/v2")]
        output_dir: PathBuf,
    },
    /// Derive deployment-pinned public signing keys from server seeds.
    SigningKeys {
        #[arg(long, env = "ZKAPI_STATE_SEED")]
        state_seed: String,
        #[arg(long, env = "ZKAPI_CLEAR_SEED")]
        clear_seed: String,
    },
    Keygen,
    #[command(name = "clientd", alias = "auth", alias = "serve-auth")]
    Clientd {
        #[arg(long, default_value = "127.0.0.1:11434")]
        listen: String,
        #[arg(long, value_enum, default_value_t = ClientModeArg::Proxy)]
        mode: ClientModeArg,
    },
    /// Start a ready-to-use local OpenAI/Ollama-compatible client.
    ///
    /// By default this loads the experimental Ethereum Mainnet deployment,
    /// reuses an existing local note or serves the MetaMask funding UI for a
    /// new one, then listens on 127.0.0.1:11434.
    Client {
        /// Deployment manifest URL or local JSON path.
        #[arg(long, default_value = PUBLIC_MAINNET_MANIFEST)]
        deployment: String,
        /// Depositor address to fund. Omit to let cast derive it interactively.
        #[arg(long)]
        address: Option<String>,
        /// Local HTTP address for OpenAI, Responses, and Ollama-compatible APIs.
        #[arg(long, default_value = "127.0.0.1:11434")]
        listen: String,
        /// Managed private wallet state directory. Defaults to a deployment-specific user state path.
        #[arg(long)]
        state_dir: Option<PathBuf>,
        /// Billing-token base units to deposit when the client needs a fresh note.
        #[arg(long, default_value_t = 2_000_000)]
        initial_credits: u128,
        /// Start without automatic cast funding or low-balance note rotation.
        #[arg(long, hide = true)]
        no_fund: bool,
        /// Use the legacy interactive cast funding flow before starting. By
        /// default the daemon starts immediately and the bundled UI funds with
        /// MetaMask.
        #[arg(long)]
        fund_with_cast: bool,
        /// Do not call a test deployment's optional faucet-style mint method.
        #[arg(long)]
        skip_mint: bool,
        /// Request transport: server-side proxying, or prompt-private direct OpenRouter leases.
        #[arg(long, value_enum, default_value_t = ClientModeArg::Proxy)]
        mode: ClientModeArg,
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
        /// Metered provider: OpenAI API key (pass-through for bare model ids).
        #[arg(long)]
        openai_api_key: Option<String>,
        /// Metered provider: OpenAI base URL.
        #[arg(long, default_value = "https://api.openai.com")]
        openai_api_base: String,
        /// Metered provider: OpenRouter API key for server-side pass-through.
        #[arg(long)]
        openrouter_inference_key: Option<String>,
        /// Metered provider: OpenRouter base URL.
        #[arg(long, default_value = "https://openrouter.ai/api")]
        openrouter_api_base: String,
        /// OpenRouter Management API key used only to mint bounded runtime leases.
        #[arg(long)]
        openrouter_management_key: Option<String>,
        /// OA org base URL used to obtain station-issued, verifier-backed keys.
        #[arg(long)]
        oa_org_url: Option<String>,
        /// Validity of each prompt-private runtime key.
        #[arg(long, default_value_t = 300)]
        openrouter_lease_ttl_seconds: u64,
        /// Usage propagation delay after key expiry before settlement.
        #[arg(long, default_value_t = 5)]
        openrouter_settlement_grace_seconds: u64,
        #[arg(long, default_value_t = 2)]
        openrouter_settlement_poll_seconds: u64,
        #[arg(long, default_value = "zkapi-server.db")]
        db_path: String,
        /// State-signing secret seed. Falls back to ZKAPI_STATE_SEED, then 0x1.
        #[arg(long)]
        state_seed: Option<String>,
        /// Clearance-signing secret seed. Falls back to ZKAPI_CLEAR_SEED, then 0x2.
        #[arg(long)]
        clear_seed: Option<String>,
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
    /// Settle active usage and withdraw the current managed note on chain.
    Withdraw {
        /// Payout address. Required for mutual and escape initiation.
        #[arg(long)]
        destination: Option<String>,
        #[arg(long, value_enum, default_value_t = WithdrawalModeArg::Mutual)]
        mode: WithdrawalModeArg,
        /// Deployment manifest URL or local JSON path.
        #[arg(long, default_value = PUBLIC_MAINNET_MANIFEST)]
        deployment: String,
        /// Running local zkAPI client gateway.
        #[arg(long, default_value = "http://127.0.0.1:11434")]
        client_url: String,
        /// Note to finalize. Defaults to the local client's active note.
        #[arg(long)]
        note_id: Option<u32>,
        /// Simulate without submitting. Mutual mode still reserves server clearance and makes the note withdrawal-only.
        #[arg(long)]
        dry_run: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum WithdrawalModeArg {
    Mutual,
    Escape,
    FinalizeEscape,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ClientModeArg {
    Proxy,
    DirectOpenrouter,
}

#[derive(Debug, Clone, ValueEnum)]
enum ProviderArg {
    Echo,
    HttpProxy,
    /// Token-usage-metered upstream (OpenAI / OpenRouter) with real billing.
    Metered,
}

/// Public client parameters published by a v2 deployment. The one-command
/// client reads this manifest instead of requiring callers to copy contract
/// addresses and public signing keys into shell variables.
#[derive(Debug, Deserialize)]
struct DeploymentManifest {
    deployment_id: String,
    protocol_version: u16,
    chain_id: u64,
    rpc_url: String,
    contract_address: String,
    billing_token_address: Option<String>,
    #[serde(default)]
    demo_mint_enabled: bool,
    protocol_server_url: String,
    indexer_url: String,
    request_charge_cap: u128,
    proof_backend: String,
    state_signing_key: DeploymentCurvePoint,
    clearance_signing_key: DeploymentCurvePoint,
    #[serde(default)]
    models: Vec<ModelDescriptor>,
}

#[derive(Debug, Deserialize)]
struct DeploymentCurvePoint {
    x: String,
    y: String,
}

#[derive(Debug, Deserialize)]
struct NextNoteIdResponse {
    next_note_id: u32,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(log_filter())
        .init();

    let cli = Cli::parse();

    match cli.command.clone() {
        Commands::Setup { output_dir } => {
            zkapi_proof::compact::setup(&output_dir)?;
            print_json(&serde_json::json!({
                "status": "ok",
                "proof_backend": "groth16_bn254",
                "output_dir": output_dir,
            }))?;
        }
        Commands::SigningKeys {
            state_seed,
            clear_seed,
        } => {
            let state = zkapi_proof::compact::CompactSigner::from_seed(&parse_felt(
                "state seed",
                &state_seed,
            )?);
            let clearance = zkapi_proof::compact::CompactSigner::from_seed(&parse_felt(
                "clearance seed",
                &clear_seed,
            )?);
            print_json(&serde_json::json!({
                "state_signing_key": state.public_key(),
                "clearance_signing_key": clearance.public_key(),
            }))?;
        }
        Commands::Keygen => {
            let wallet = Wallet::new(client_config(&cli)?)
                .map_err(|err| anyhow::anyhow!("failed to create wallet: {err}"))?;
            let (secret, commitment) = wallet.generate_deposit_params();
            print_json(&serde_json::json!({
                "secret": secret,
                "commitment": commitment,
            }))?;
        }
        Commands::Clientd { listen, mode } => {
            let service = build_auth_service_with_mode(&cli, mode.into())?;
            service.ensure_request_mode_available().await?;
            run(service, &listen).await?
        }
        Commands::Client {
            deployment,
            address,
            listen,
            state_dir,
            initial_credits,
            no_fund,
            fund_with_cast,
            skip_mint,
            mode,
        } => {
            configure_client_prover_threads()?;
            run_one_command_client(OneCommandClientOptions {
                deployment: &deployment,
                requested_address: address.as_deref(),
                listen: &listen,
                requested_state_dir: state_dir,
                initial_credits,
                no_fund: no_fund || !fund_with_cast,
                skip_mint,
                request_mode: mode.into(),
                oa_verifier_url: cli.oa_verifier_url.clone(),
                openrouter_inference_base: cli.openrouter_inference_base.clone(),
                require_oa_org_key_source: cli.require_oa_org_key_source,
            })
            .await?
        }
        Commands::Serverd {
            listen,
            provider,
            flat_charge,
            upstream_url,
            proxy_timeout_ms,
            openai_api_key,
            openai_api_base,
            openrouter_inference_key,
            openrouter_api_base,
            openrouter_management_key,
            oa_org_url,
            openrouter_lease_ttl_seconds,
            openrouter_settlement_grace_seconds,
            openrouter_settlement_poll_seconds,
            db_path,
            state_seed,
            clear_seed,
            initial_root,
            indexer_url,
            root_poll_interval_ms,
        } => {
            let state_seed = resolve_secret(state_seed, std::env::var("ZKAPI_STATE_SEED").ok())
                .unwrap_or_else(|| "0x1".to_string());
            let clear_seed = resolve_secret(clear_seed, std::env::var("ZKAPI_CLEAR_SEED").ok())
                .unwrap_or_else(|| "0x2".to_string());
            let openrouter_api_base_for_leases = openrouter_api_base.clone();
            let metered = if matches!(provider, ProviderArg::Metered) {
                Some(MeteredConfig {
                    openai_api_base,
                    openai_api_key: resolve_secret(
                        openai_api_key,
                        std::env::var("ZKAPI_OPENAI_API_KEY").ok(),
                    ),
                    openrouter_api_base,
                    openrouter_inference_key: resolve_secret(
                        openrouter_inference_key,
                        std::env::var("ZKAPI_OPENROUTER_INFERENCE_KEY").ok(),
                    ),
                })
            } else {
                None
            };
            let openrouter_management_key = resolve_secret(
                openrouter_management_key,
                std::env::var("ZKAPI_OPENROUTER_MANAGEMENT_KEY").ok(),
            );
            let oa_org_shared_secret =
                resolve_secret(None, std::env::var("ZKAPI_OA_ORG_SHARED_SECRET").ok());
            let lease_source = match (openrouter_management_key, oa_org_url, oa_org_shared_secret) {
                (Some(_), Some(_), _) | (Some(_), _, Some(_)) => {
                    anyhow::bail!(
                        "configure either direct OpenRouter management or OA org key issuance, not both"
                    )
                }
                (Some(management_key), None, None) => {
                    Some(OpenRouterLeaseSourceConfig::OpenRouter {
                        management_key,
                        api_base: openrouter_api_base_for_leases,
                    })
                }
                (None, Some(org_base_url), Some(shared_secret)) => {
                    Some(OpenRouterLeaseSourceConfig::OaOrg {
                        org_base_url,
                        shared_secret,
                    })
                }
                (None, Some(_), None) => {
                    anyhow::bail!("--oa-org-url requires an OA org shared secret")
                }
                (None, None, Some(_)) => {
                    anyhow::bail!("an OA org shared secret requires --oa-org-url")
                }
                (None, None, None) => None,
            };
            let openrouter_leases = lease_source.map(|source| OpenRouterLeaseConfig {
                source,
                ttl_seconds: openrouter_lease_ttl_seconds,
                settlement_grace_seconds: openrouter_settlement_grace_seconds,
                settlement_poll_seconds: openrouter_settlement_poll_seconds,
            });
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
                    ProviderArg::Metered => ProviderKind::Metered,
                },
                echo_fixed_charge: flat_charge,
                proxy_default_charge: flat_charge,
                proxy_upstream_url: upstream_url,
                proxy_timeout_ms,
                db_path,
                state_seed: parse_felt("state seed", &state_seed)?,
                clear_seed: parse_felt("clear seed", &clear_seed)?,
                initial_root: parse_felt("initial root", &initial_root)?,
                indexer_url,
                root_poll_interval_ms,
                trusted_epoch_roots: load_trusted_epoch_roots(cli.trusted_epoch_roots.as_deref())?,
                metered,
                openrouter_leases,
                proof_setup_dir: cli.proof_setup_dir.clone(),
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
        Commands::Withdraw {
            destination,
            mode,
            deployment,
            client_url,
            note_id,
            dry_run,
        } => {
            run_managed_withdrawal(ManagedWithdrawalOptions {
                deployment: &deployment,
                client_url: &client_url,
                destination: destination.as_deref(),
                mode,
                note_id,
                dry_run,
            })
            .await?;
        }
    }

    Ok(())
}

fn log_filter() -> tracing_subscriber::EnvFilter {
    const DEFAULT: &str =
        "warn,zkapi=info,zkapi_clientd=info,zkapi_serverd=info,zkapi_indexerd=info";
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| DEFAULT.into());

    // ark-r1cs-std instruments fine-grained field operations at INFO under the
    // `r1cs` target. Enabling those spans while proving debug-formats growing
    // constraint systems, turning a ~3-second proof into multi-gigabyte work.
    // Keep them disabled even when a caller uses a broad `RUST_LOG=info`.
    suppress_r1cs_info(filter)
}

fn suppress_r1cs_info(filter: tracing_subscriber::EnvFilter) -> tracing_subscriber::EnvFilter {
    filter.add_directive("r1cs=warn".parse().expect("valid r1cs log directive"))
}

/// Keep local Groth16 generation responsive without allowing arkworks' global
/// Rayon pool to saturate every logical CPU. Advanced callers can override the
/// default before launch with the standard `RAYON_NUM_THREADS` variable.
fn configure_client_prover_threads() -> anyhow::Result<()> {
    if std::env::var_os("RAYON_NUM_THREADS").is_some() {
        tracing::info!("using RAYON_NUM_THREADS for local proof generation");
        return Ok(());
    }

    const DEFAULT_PROVER_THREADS: usize = 2;
    rayon::ThreadPoolBuilder::new()
        .num_threads(DEFAULT_PROVER_THREADS)
        .build_global()
        .map_err(|error| anyhow::anyhow!("failed to configure prover worker threads: {error}"))?;
    tracing::info!(
        prover_threads = DEFAULT_PROVER_THREADS,
        "configured local proof generation"
    );
    Ok(())
}

fn build_auth_service(cli: &Cli) -> anyhow::Result<Arc<AuthService>> {
    build_auth_service_with_mode(cli, RequestMode::Proxy)
}

fn build_auth_service_with_mode(
    cli: &Cli,
    request_mode: RequestMode,
) -> anyhow::Result<Arc<AuthService>> {
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
        suggested_deposit_amount: cli.request_charge_cap.saturating_mul(2),
        demo_rpc_url: cli.demo_rpc_url.clone(),
        demo_billing_token_address: cli.demo_billing_token_address.clone(),
        demo_mint_enabled: false,
        demo_note_ttl_seconds: cli.demo_note_ttl_seconds,
        proof_mode: "groth16_bn254".to_string(),
        cairo_dir: String::new(),
        trusted_epoch_roots: load_trusted_epoch_roots(cli.trusted_epoch_roots.as_deref())?,
        proof_setup_dir: cli.proof_setup_dir.clone(),
        state_signing_key: parse_curve_point(
            "state signing key",
            &cli.state_signing_key_x,
            &cli.state_signing_key_y,
        )?,
        clearance_signing_key: parse_curve_point(
            "clearance signing key",
            &cli.clearance_signing_key_x,
            &cli.clearance_signing_key_y,
        )?,
        request_mode,
        oa_verifier_url: cli.oa_verifier_url.clone(),
        openrouter_inference_base: cli.openrouter_inference_base.clone(),
        require_oa_org_key_source: cli.require_oa_org_key_source,
    })
    .map_err(Into::into)
}

/// Start the local compatibility daemon from a published public deployment
/// manifest. This is the low-friction entrypoint: no caller has to repeat the
/// deployment's addresses, chain parameters, proving setup, or server keys.
struct OneCommandClientOptions<'a> {
    deployment: &'a str,
    requested_address: Option<&'a str>,
    listen: &'a str,
    requested_state_dir: Option<PathBuf>,
    initial_credits: u128,
    no_fund: bool,
    skip_mint: bool,
    request_mode: RequestMode,
    oa_verifier_url: String,
    openrouter_inference_base: String,
    require_oa_org_key_source: bool,
}

struct LocalClientPolicy {
    request_mode: RequestMode,
    suggested_deposit_amount: u128,
    allow_demo_mint: bool,
    oa_verifier_url: String,
    openrouter_inference_base: String,
    require_oa_org_key_source: bool,
}

async fn run_one_command_client(options: OneCommandClientOptions<'_>) -> anyhow::Result<()> {
    let OneCommandClientOptions {
        deployment,
        requested_address,
        listen,
        requested_state_dir,
        initial_credits,
        no_fund,
        skip_mint,
        request_mode,
        oa_verifier_url,
        openrouter_inference_base,
        require_oa_org_key_source,
    } = options;
    let manifest = load_deployment_manifest(deployment).await?;
    validate_deployment_manifest(&manifest)?;

    let state_dir =
        requested_state_dir.unwrap_or_else(|| default_client_state_dir(&manifest.deployment_id));
    ensure_private_state_dir(&state_dir)?;
    let service = auth_service_from_manifest(
        &manifest,
        state_dir.clone(),
        listen,
        LocalClientPolicy {
            request_mode,
            suggested_deposit_amount: initial_credits,
            allow_demo_mint: manifest.demo_mint_enabled && !skip_mint,
            oa_verifier_url,
            openrouter_inference_base,
            require_oa_org_key_source,
        },
    )?;
    service.ensure_request_mode_available().await?;

    let status = service.status().await?;
    if !status.has_note {
        if no_fund {
            eprintln!(
                "No active zkAPI note in {}. Starting without funding; requests will return 402 until funded.",
                state_dir.display()
            );
        } else {
            if manifest.chain_id == 1 && !manifest.demo_mint_enabled {
                eprintln!(
                    "WARNING: this is Ethereum Mainnet. Funding will approve and deposit {initial_credits} real billing-token base units into unaudited experimental contracts."
                );
            }
            eprintln!(
                "No active zkAPI note in {}. Funding {} billing credits now; cast will securely prompt once for the wallet key.",
                state_dir.display(),
                initial_credits
            );
            fund_public_deployment(
                &service,
                &manifest,
                requested_address,
                initial_credits,
                skip_mint,
            )
            .await?;
        }
    } else if let Some(note) = status.note {
        if note.current_balance <= manifest.request_charge_cap {
            if no_fund {
                eprintln!(
                    "Warning: active note {} has {} credits and no reserve beyond this deployment's {}-credit per-request proof bound. Paid requests may return 402.",
                    note.note_id, note.current_balance, manifest.request_charge_cap
                );
            } else {
                let retired = service.retire_low_balance_note().await?.ok_or_else(|| {
                    anyhow::anyhow!(
                        "active note state changed while preparing automatic rotation; retry startup"
                    )
                })?;
                eprintln!(
                    "Retired low-balance note {} with {} credits to {}. Funding a fresh active note automatically.",
                    retired.note_id,
                    retired.remaining_balance,
                    retired.state_dir.display()
                );
                fund_public_deployment(
                    &service,
                    &manifest,
                    requested_address,
                    initial_credits,
                    skip_mint,
                )
                .await?;
            }
        }
    }

    println!("zkAPI local gateway: http://{listen}");
    println!("  Chat + MetaMask funding:  http://{listen}/");
    println!("  OpenAI Chat Completions: http://{listen}/v1/chat/completions");
    println!("  OpenAI Responses:        http://{listen}/v1/responses");
    println!("  Ollama Chat:              http://{listen}/api/chat");
    println!("  Models:                   http://{listen}/v1/models");
    match request_mode {
        RequestMode::Proxy => println!("  Privacy mode:             server proxy"),
        RequestMode::DirectOpenrouter => println!(
            "  Privacy mode:             direct OpenRouter (zkAPI server receives no prompts or responses)"
        ),
    }

    run(service, listen).await
}

async fn load_deployment_manifest(source: &str) -> anyhow::Result<DeploymentManifest> {
    let bytes = if source.starts_with("https://") || source.starts_with("http://") {
        reqwest::get(source)
            .await
            .map_err(|err| anyhow::anyhow!("failed to fetch deployment manifest {source}: {err}"))?
            .error_for_status()
            .map_err(|err| {
                anyhow::anyhow!("deployment manifest {source} returned an error: {err}")
            })?
            .bytes()
            .await
            .map_err(|err| anyhow::anyhow!("failed to read deployment manifest {source}: {err}"))?
            .to_vec()
    } else {
        std::fs::read(source)
            .map_err(|err| anyhow::anyhow!("failed to read deployment manifest {source}: {err}"))?
    };

    serde_json::from_slice(&bytes)
        .map_err(|err| anyhow::anyhow!("invalid deployment manifest {source}: {err}"))
}

fn validate_deployment_manifest(manifest: &DeploymentManifest) -> anyhow::Result<()> {
    if manifest.protocol_version != 2 {
        anyhow::bail!(
            "deployment {} uses unsupported protocol version {}; expected v2",
            manifest.deployment_id,
            manifest.protocol_version
        );
    }
    if manifest.proof_backend != "groth16_bn254" {
        anyhow::bail!(
            "deployment {} uses unsupported proof backend {}; expected groth16_bn254",
            manifest.deployment_id,
            manifest.proof_backend
        );
    }
    if manifest.protocol_server_url.is_empty() || manifest.indexer_url.is_empty() {
        anyhow::bail!(
            "deployment {} is missing public service URLs",
            manifest.deployment_id
        );
    }
    Ok(())
}

fn auth_service_from_manifest(
    manifest: &DeploymentManifest,
    state_dir: PathBuf,
    listen: &str,
    policy: LocalClientPolicy,
) -> anyhow::Result<Arc<AuthService>> {
    let LocalClientPolicy {
        request_mode,
        suggested_deposit_amount,
        allow_demo_mint,
        oa_verifier_url,
        openrouter_inference_base,
        require_oa_org_key_source,
    } = policy;
    let models = if manifest.models.is_empty() {
        vec![ModelDescriptor::new("openai/gpt-4o-mini")]
    } else {
        manifest.models.clone()
    };
    AuthService::new(AuthConfig {
        protocol_version: manifest.protocol_version,
        chain_id: manifest.chain_id,
        contract_address: parse_felt("deployment contract address", &manifest.contract_address)?,
        request_charge_cap: manifest.request_charge_cap,
        policy_charge_cap: 10_000_000,
        policy_enabled: false,
        auth_scheme: zkapi_auth::AuthSchemeKind::StateAnchor,
        protocol_server_url: manifest.protocol_server_url.clone(),
        indexer_url: manifest.indexer_url.clone(),
        listen_addr: listen.to_string(),
        state_dir,
        models,
        suggested_deposit_amount,
        demo_rpc_url: Some(manifest.rpc_url.clone()),
        demo_billing_token_address: manifest.billing_token_address.clone(),
        demo_mint_enabled: manifest.demo_mint_enabled && allow_demo_mint,
        demo_note_ttl_seconds: None,
        proof_mode: "groth16_bn254".to_string(),
        cairo_dir: String::new(),
        trusted_epoch_roots: Vec::new(),
        proof_setup_dir: "protocol/setup/v2".to_string(),
        state_signing_key: parse_curve_point(
            "deployment state signing key",
            &manifest.state_signing_key.x,
            &manifest.state_signing_key.y,
        )?,
        clearance_signing_key: parse_curve_point(
            "deployment clearance signing key",
            &manifest.clearance_signing_key.x,
            &manifest.clearance_signing_key.y,
        )?,
        request_mode,
        oa_verifier_url,
        openrouter_inference_base,
        require_oa_org_key_source,
    })
    .map_err(Into::into)
}

/// Create, submit, and confirm the first note with one terminal key prompt from
/// Foundry's `cast`. The key is kept in a temporary encrypted keystore only for
/// this funding flow and never enters zkAPI's argument parser or state files.
async fn fund_public_deployment(
    service: &Arc<AuthService>,
    manifest: &DeploymentManifest,
    requested_address: Option<&str>,
    amount: u128,
    skip_mint: bool,
) -> anyhow::Result<()> {
    let minimum = minimum_initial_credits(manifest.request_charge_cap)?;
    if amount < minimum {
        anyhow::bail!(
            "initial credits {amount} leave no safe balance after one maximum-cost request; choose --initial-credits at least {minimum} (twice this deployment's {}-credit per-request proof bound)",
            manifest.request_charge_cap,
        );
    }
    let token = manifest.billing_token_address.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "deployment {} has no billing token. Native ETH funding requires a separate native-asset vault deployment; this v2 vault accepts its configured ERC-20 token.",
            manifest.deployment_id
        )
    })?;
    let signer = create_ephemeral_cast_signer()?;
    let address = match requested_address {
        Some(address) => {
            let requested = normalize_address(address)?;
            if signer.address != requested {
                anyhow::bail!(
                    "--address {requested} does not match the private key's address {}",
                    signer.address
                );
            }
            requested
        }
        None => signer.address.clone(),
    };
    let plan = service.prepare_deposit(amount).await?;
    let amount = plan.amount.to_string();
    let commitment = felt_as_bytes32(&plan.commitment);
    let siblings = felt_array_argument(&plan.zero_path);
    let note_id = plan.next_note_id;

    if !skip_mint && manifest.demo_mint_enabled {
        run_cast_signed(
            &signer,
            &[
                "send".to_string(),
                "--rpc-url".to_string(),
                manifest.rpc_url.clone(),
                token.to_string(),
                "mint(address,uint256)".to_string(),
                address.clone(),
                amount.clone(),
            ],
        )?;
    } else if !skip_mint {
        eprintln!(
            "This deployment uses a real billing token and has no faucet mint. The selected address must already hold at least {amount} token base units."
        );
    }
    let decimals = read_erc20_u128(&manifest.rpc_url, token, "decimals()(uint8)", &[])?;
    if decimals != 6 {
        anyhow::bail!(
            "billing token {token} reports {decimals} decimals; zkAPI credits require a 6-decimal billing token"
        );
    }
    let balance = read_erc20_u128(
        &manifest.rpc_url,
        token,
        "balanceOf(address)(uint256)",
        std::slice::from_ref(&address),
    )?;
    if balance < plan.amount {
        anyhow::bail!(
            "address {address} has {balance} billing-token base units but this deposit needs {}; fund it with at least {} more before retrying",
            plan.amount,
            plan.amount - balance
        );
    }
    run_cast_signed(
        &signer,
        &[
            "send".to_string(),
            "--rpc-url".to_string(),
            manifest.rpc_url.clone(),
            token.to_string(),
            "approve(address,uint256)".to_string(),
            manifest.contract_address.clone(),
            amount.clone(),
        ],
    )?;
    run_cast_signed(
        &signer,
        &[
            "send".to_string(),
            "--rpc-url".to_string(),
            manifest.rpc_url.clone(),
            manifest.contract_address.clone(),
            "deposit(bytes32,uint128,uint256[32])".to_string(),
            commitment,
            amount.clone(),
            siblings,
        ],
    )?;

    wait_for_indexed_note(&manifest.indexer_url, note_id).await?;
    let expiry_ts = read_note_expiry(manifest, note_id)?;
    service
        .confirm_deposit(ConfirmDepositRequest {
            secret: plan.secret,
            note_id,
            amount: plan.amount,
            expiry_ts,
        })
        .await?;

    println!(
        "Funded note {note_id} with {} credits for {address}.",
        plan.amount
    );
    Ok(())
}

struct ManagedWithdrawalOptions<'a> {
    deployment: &'a str,
    client_url: &'a str,
    destination: Option<&'a str>,
    mode: WithdrawalModeArg,
    note_id: Option<u32>,
    dry_run: bool,
}

async fn run_managed_withdrawal(options: ManagedWithdrawalOptions<'_>) -> anyhow::Result<()> {
    let manifest = load_deployment_manifest(options.deployment).await?;
    validate_deployment_manifest(&manifest)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()?;
    let funding: FundingConfig = local_client_request(
        &client,
        reqwest::Method::GET,
        options.client_url,
        "/funding/config",
        None,
    )
    .await
    .map_err(|error| {
        anyhow::anyhow!(
            "cannot reach the managed zkAPI client at {}: {error}. Start `zkapi client` first",
            options.client_url
        )
    })?;
    validate_client_deployment(&funding, &manifest)?;

    if options.mode == WithdrawalModeArg::FinalizeEscape {
        if options.destination.is_some() {
            anyhow::bail!("--destination is not used with --mode finalize-escape");
        }
        return finalize_escape_withdrawal(&client, &manifest, &options).await;
    }
    if options.note_id.is_some() {
        anyhow::bail!("--note-id is only used with --mode finalize-escape");
    }

    let destination = options.destination.ok_or_else(|| {
        anyhow::anyhow!("--destination is required for mutual and escape withdrawals")
    })?;
    let destination = normalize_address(destination)?;

    eprintln!("Settling any active zkAPI request or OpenRouter key before withdrawal...");
    let settled: WalletStatus = local_client_request(
        &client,
        reqwest::Method::POST,
        options.client_url,
        "/wallet/settle",
        None,
    )
    .await?;
    let local_note = settled
        .note
        .ok_or_else(|| anyhow::anyhow!("the local client has no active note to withdraw"))?;
    if settled.pending_request {
        anyhow::bail!("the local client still has a pending request after settlement");
    }

    let mode = match options.mode {
        WithdrawalModeArg::Mutual => WithdrawalMode::Mutual,
        WithdrawalModeArg::Escape => WithdrawalMode::Escape,
        WithdrawalModeArg::FinalizeEscape => unreachable!("handled above"),
    };
    eprintln!("Generating the Groth16 withdrawal proof...");
    let plan: WithdrawalPlan = local_client_request(
        &client,
        reqwest::Method::POST,
        options.client_url,
        "/wallet/withdraw",
        Some(serde_json::json!({
            "mode": match mode {
                WithdrawalMode::Mutual => "mutual",
                WithdrawalMode::Escape => "escape",
            },
            "destination": destination,
        })),
    )
    .await?;
    validate_withdrawal_plan(&plan, &manifest, mode, &destination)?;
    if plan.public_inputs.note_id != local_note.note_id {
        anyhow::bail!(
            "the withdrawal proof is for note {}, but the settled local note is {}",
            plan.public_inputs.note_id,
            local_note.note_id
        );
    }

    run_withdrawal_contract_call(&manifest, &plan, options.dry_run)?;
    if options.dry_run {
        if mode == WithdrawalMode::Mutual {
            eprintln!(
                "Mutual-close clearance is now reserved. This note cannot make more LLM requests; rerun this command without --dry-run to withdraw it."
            );
        }
        return print_json(&serde_json::json!({
            "deployment": manifest.deployment_id,
            "mode": plan.mode,
            "note_id": plan.public_inputs.note_id,
            "destination": destination,
            "final_balance": plan.public_inputs.final_balance,
            "simulation": "succeeded",
            "submitted": false,
            "note_usage": if mode == WithdrawalMode::Mutual { "withdrawal_only" } else { "unchanged" },
        }));
    }

    let expected_status = match mode {
        WithdrawalMode::Mutual => 3,
        WithdrawalMode::Escape => 2,
    };
    wait_for_note_status(&manifest, plan.public_inputs.note_id, expected_status).await?;

    if mode == WithdrawalMode::Mutual {
        let reset: WalletStatus = local_client_request(
            &client,
            reqwest::Method::POST,
            options.client_url,
            "/wallet/reset",
            None,
        )
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "the on-chain withdrawal succeeded, but local wallet cleanup failed: {error}"
            )
        })?;
        if reset.has_note {
            anyhow::bail!(
                "the on-chain withdrawal succeeded, but the local client still reports an active note"
            );
        }
        print_json(&serde_json::json!({
            "deployment": manifest.deployment_id,
            "mode": plan.mode,
            "note_id": plan.public_inputs.note_id,
            "destination": destination,
            "final_balance": plan.public_inputs.final_balance,
            "onchain_status": "closed",
            "local_wallet_reset": true,
            "submitted": true,
        }))
    } else {
        let challenge_deadline = read_escape_deadline(&manifest, plan.public_inputs.note_id)?;
        print_json(&serde_json::json!({
            "deployment": manifest.deployment_id,
            "mode": plan.mode,
            "note_id": plan.public_inputs.note_id,
            "destination": destination,
            "final_balance": plan.public_inputs.final_balance,
            "onchain_status": "pending_withdrawal",
            "challenge_deadline": challenge_deadline,
            "local_wallet_reset": false,
            "submitted": true,
            "next": format!(
                "After the challenge deadline, run: zkapi withdraw --deployment {} --mode finalize-escape --note-id {}",
                options.deployment, plan.public_inputs.note_id
            ),
        }))
    }
}

async fn finalize_escape_withdrawal(
    client: &reqwest::Client,
    manifest: &DeploymentManifest,
    options: &ManagedWithdrawalOptions<'_>,
) -> anyhow::Result<()> {
    let local: WalletStatus = local_client_request(
        client,
        reqwest::Method::GET,
        options.client_url,
        "/wallet/status",
        None,
    )
    .await?;
    let local_note_id = local.note.as_ref().map(|note| note.note_id);
    let note_id = options.note_id.or(local_note_id).ok_or_else(|| {
        anyhow::anyhow!("--note-id is required when the local client has no active note")
    })?;
    if let Some(local_note_id) = local_note_id {
        if local_note_id != note_id {
            anyhow::bail!(
                "--note-id {note_id} does not match the local client's note {local_note_id}"
            );
        }
    }

    let current_status = read_note_status(manifest, note_id)?;
    if current_status != 2 && current_status != 3 {
        anyhow::bail!(
            "note {note_id} is not pending an escape withdrawal (on-chain status {current_status})"
        );
    }

    if current_status == 2 {
        run_finalize_escape_call(manifest, note_id, options.dry_run)?;
        if options.dry_run {
            return print_json(&serde_json::json!({
                "deployment": manifest.deployment_id,
                "mode": "finalize_escape",
                "note_id": note_id,
                "simulation": "succeeded",
                "submitted": false,
            }));
        }
        wait_for_note_status(manifest, note_id, 3).await?;
    } else if options.dry_run {
        anyhow::bail!("note {note_id} is already closed; there is nothing to simulate");
    }

    let local_wallet_reset = if local_note_id == Some(note_id) {
        let reset: WalletStatus = local_client_request(
            client,
            reqwest::Method::POST,
            options.client_url,
            "/wallet/reset",
            None,
        )
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "escape finalization succeeded, but local wallet cleanup failed: {error}"
            )
        })?;
        if reset.has_note {
            anyhow::bail!(
                "escape finalization succeeded, but the local client still reports an active note"
            );
        }
        true
    } else {
        false
    };

    print_json(&serde_json::json!({
        "deployment": manifest.deployment_id,
        "mode": "finalize_escape",
        "note_id": note_id,
        "onchain_status": "closed",
        "local_wallet_reset": local_wallet_reset,
        "submitted": current_status == 2,
    }))
}

async fn local_client_request<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    method: reqwest::Method,
    client_url: &str,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<T> {
    let endpoint = local_client_endpoint(client_url, path)?;
    let mut request = client.request(method, endpoint.clone());
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("request to {endpoint} failed: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| anyhow::anyhow!("could not read {endpoint}: {error}"))?;
    if !status.is_success() {
        let message = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| value["error"]["message"].as_str().map(str::to_owned))
            .unwrap_or_else(|| String::from_utf8_lossy(&bytes).trim().to_string());
        anyhow::bail!("local client returned HTTP {status}: {message}");
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| anyhow::anyhow!("local client returned invalid JSON: {error}"))
}

fn local_client_endpoint(client_url: &str, path: &str) -> anyhow::Result<String> {
    let mut url = reqwest::Url::parse(client_url)
        .map_err(|error| anyhow::anyhow!("invalid --client-url: {error}"))?;
    let local_host = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    if url.scheme() != "http"
        || !local_host
        || !url.username().is_empty()
        || url.password().is_some()
    {
        anyhow::bail!("--client-url must be an unauthenticated loopback HTTP URL");
    }
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn validate_client_deployment(
    funding: &FundingConfig,
    manifest: &DeploymentManifest,
) -> anyhow::Result<()> {
    let manifest_contract = parse_felt("deployment contract address", &manifest.contract_address)?;
    if funding.chain_id != manifest.chain_id || funding.contract_address != manifest_contract {
        anyhow::bail!(
            "the running client uses chain {} contract {}, but --deployment selects chain {} contract {}; use the same manifest for `client` and `withdraw`",
            funding.chain_id,
            funding.contract_address,
            manifest.chain_id,
            manifest.contract_address
        );
    }
    Ok(())
}

fn validate_withdrawal_plan(
    plan: &WithdrawalPlan,
    manifest: &DeploymentManifest,
    mode: WithdrawalMode,
    destination: &str,
) -> anyhow::Result<()> {
    let inputs = &plan.public_inputs;
    if plan.mode != mode {
        anyhow::bail!("local client returned the wrong withdrawal mode");
    }
    if inputs.protocol_version != manifest.protocol_version
        || inputs.chain_id != manifest.chain_id
        || inputs.contract_address
            != parse_felt("deployment contract address", &manifest.contract_address)?
    {
        anyhow::bail!("withdrawal proof does not match the selected deployment");
    }
    if normalize_address(destination)? != format!("0x{}", hex::encode(inputs.destination)) {
        anyhow::bail!("withdrawal proof does not match --destination");
    }
    let expected_clearance = mode == WithdrawalMode::Mutual;
    if inputs.has_clearance != expected_clearance {
        anyhow::bail!("withdrawal proof has an invalid clearance mode");
    }
    if plan.siblings.len() != 32 {
        anyhow::bail!(
            "withdrawal proof returned {} Merkle siblings; expected 32",
            plan.siblings.len()
        );
    }
    if plan.proof.backend != ProofBackendWire::Groth16Bn254 {
        anyhow::bail!("withdrawal proof is not Groth16 BN254");
    }
    let proof = base64::engine::general_purpose::STANDARD
        .decode(&plan.proof.proof)
        .map_err(|error| anyhow::anyhow!("withdrawal proof is invalid base64: {error}"))?;
    if proof.is_empty() {
        anyhow::bail!("withdrawal proof is empty");
    }
    Ok(())
}

const WITHDRAWAL_INPUTS_ABI: &str = "(uint16,uint64,address,uint256,uint256,uint256,uint256,uint256,uint32,uint128,address,uint256,bool,uint256)";

fn run_withdrawal_contract_call(
    manifest: &DeploymentManifest,
    plan: &WithdrawalPlan,
    dry_run: bool,
) -> anyhow::Result<()> {
    let function = match plan.mode {
        WithdrawalMode::Mutual => format!("mutualClose({WITHDRAWAL_INPUTS_ABI},bytes,uint256[32])"),
        WithdrawalMode::Escape => {
            format!("initiateEscapeWithdrawal({WITHDRAWAL_INPUTS_ABI},bytes,uint256[32])")
        }
    };
    let inputs = withdrawal_inputs_argument(plan)?;
    let proof = base64::engine::general_purpose::STANDARD
        .decode(&plan.proof.proof)
        .map_err(|error| anyhow::anyhow!("withdrawal proof is invalid base64: {error}"))?;
    let args = vec![
        if dry_run { "call" } else { "send" }.to_string(),
        "--rpc-url".to_string(),
        manifest.rpc_url.clone(),
        manifest.contract_address.clone(),
        function,
        inputs,
        format!("0x{}", hex::encode(proof)),
        felt_array_argument(&plan.siblings),
    ];
    if dry_run {
        eprintln!("Simulating the withdrawal against the selected deployment...");
    } else {
        eprintln!(
            "Enter a private key for an account with enough ETH to pay gas. The payout still goes to the requested destination."
        );
    }
    run_cast_transaction(&args, !dry_run, "withdrawal")
}

fn withdrawal_inputs_argument(plan: &WithdrawalPlan) -> anyhow::Result<String> {
    let inputs = &plan.public_inputs;
    let contract_address = felt_as_address(&inputs.contract_address)?;
    let destination = format!("0x{}", hex::encode(inputs.destination));
    Ok(format!(
        "({},{},{},{},{},{},{},{},{},{},{},{},{},{})",
        inputs.protocol_version,
        inputs.chain_id,
        contract_address,
        inputs.active_root,
        inputs.state_signing_key_x,
        inputs.state_signing_key_y,
        inputs.clearance_signing_key_x,
        inputs.clearance_signing_key_y,
        inputs.note_id,
        inputs.final_balance,
        destination,
        inputs.withdrawal_nullifier,
        inputs.has_clearance,
        inputs.withdrawal_tag,
    ))
}

fn run_finalize_escape_call(
    manifest: &DeploymentManifest,
    note_id: u32,
    dry_run: bool,
) -> anyhow::Result<()> {
    let args = vec![
        if dry_run { "call" } else { "send" }.to_string(),
        "--rpc-url".to_string(),
        manifest.rpc_url.clone(),
        manifest.contract_address.clone(),
        "finalizeEscapeWithdrawal(uint32)".to_string(),
        note_id.to_string(),
    ];
    if !dry_run {
        eprintln!("Enter a private key for an account with enough ETH to pay gas.");
    }
    run_cast_transaction(&args, !dry_run, "escape finalization")
}

fn run_cast_transaction(args: &[String], interactive: bool, operation: &str) -> anyhow::Result<()> {
    let mut command = Command::new("cast");
    command.args(args);
    if interactive {
        command.arg("--interactive");
    }
    let status = command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| {
            anyhow::anyhow!("failed to run cast; install Foundry's cast command: {error}")
        })?;
    if !status.success() {
        anyhow::bail!("cast {operation} failed; wallet state was preserved so you can retry");
    }
    Ok(())
}

fn felt_as_address(value: &Felt252) -> anyhow::Result<String> {
    let bytes = value.as_bytes();
    if bytes[..12].iter().any(|byte| *byte != 0) {
        anyhow::bail!("withdrawal proof contains a value that is not an Ethereum address");
    }
    Ok(format!("0x{}", hex::encode(&bytes[12..])))
}

async fn wait_for_note_status(
    manifest: &DeploymentManifest,
    note_id: u32,
    expected: u64,
) -> anyhow::Result<()> {
    let mut last = None;
    for _ in 0..20 {
        match read_note_status(manifest, note_id) {
            Ok(status) if status == expected => return Ok(()),
            Ok(status) => last = Some(status),
            Err(_) => {}
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    anyhow::bail!(
        "transaction was submitted, but note {note_id} did not reach on-chain status {expected} (last observed {last:?}); local wallet state was preserved"
    )
}

fn read_note_status(manifest: &DeploymentManifest, note_id: u32) -> anyhow::Result<u64> {
    let values = read_cast_json_values(
        manifest,
        "notes(uint32)(bytes32,uint128,uint64,uint8)",
        &[note_id.to_string()],
    )?;
    value_as_u64(values.get(3), "note status")
}

fn read_escape_deadline(manifest: &DeploymentManifest, note_id: u32) -> anyhow::Result<u64> {
    let values = read_cast_json_values(
        manifest,
        "pendingWithdrawals(uint32)(bool,uint256,uint256,uint128,address,uint64)",
        &[note_id.to_string()],
    )?;
    value_as_u64(values.get(5), "escape challenge deadline")
}

fn read_cast_json_values(
    manifest: &DeploymentManifest,
    signature: &str,
    arguments: &[String],
) -> anyhow::Result<Vec<Value>> {
    let mut command = Command::new("cast");
    command.args([
        "call",
        "--rpc-url",
        &manifest.rpc_url,
        "--json",
        &manifest.contract_address,
        signature,
    ]);
    command.args(arguments);
    let output = command.output().map_err(|error| {
        anyhow::anyhow!("failed to run cast; install Foundry's cast command: {error}")
    })?;
    if !output.status.success() {
        anyhow::bail!(
            "cast could not read vault state: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| anyhow::anyhow!("cast returned invalid vault JSON: {error}"))
}

fn value_as_u64(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    let value = value.ok_or_else(|| anyhow::anyhow!("vault getter returned no {label}"))?;
    if let Some(number) = value.as_u64() {
        return Ok(number);
    }
    if let Some(string) = value.as_str() {
        if let Some(hex) = string.strip_prefix("0x") {
            return u64::from_str_radix(hex, 16)
                .map_err(|error| anyhow::anyhow!("invalid {label} {string}: {error}"));
        }
        return string
            .parse()
            .map_err(|error| anyhow::anyhow!("invalid {label} {string}: {error}"));
    }
    anyhow::bail!("vault getter returned invalid {label}: {value}")
}

fn read_erc20_u128(
    rpc_url: &str,
    token: &str,
    signature: &str,
    arguments: &[String],
) -> anyhow::Result<u128> {
    let mut command = Command::new("cast");
    command.args(["call", "--rpc-url", rpc_url, token, signature]);
    command.args(arguments);
    let output = command.output().map_err(|err| {
        anyhow::anyhow!("failed to run cast; install Foundry's cast command: {err}")
    })?;
    if !output.status.success() {
        anyhow::bail!(
            "cast could not read billing token {token}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|err| anyhow::anyhow!("cast returned non-UTF-8 token data: {err}"))?;
    let value = stdout
        .split_whitespace()
        .next()
        .ok_or_else(|| anyhow::anyhow!("cast returned no value for {signature}"))?;
    value
        .parse()
        .map_err(|err| anyhow::anyhow!("cast returned invalid {signature} value {value}: {err}"))
}

fn minimum_initial_credits(request_charge_cap: u128) -> anyhow::Result<u128> {
    if request_charge_cap == 0 {
        anyhow::bail!("deployment request charge cap must be greater than zero");
    }
    request_charge_cap.checked_mul(2).ok_or_else(|| {
        anyhow::anyhow!("deployment request charge cap {request_charge_cap} is too large")
    })
}

async fn wait_for_indexed_note(indexer_url: &str, note_id: u32) -> anyhow::Result<()> {
    let target = note_id.saturating_add(1);
    let url = format!("{}/v1/tree/next-note-id", indexer_url.trim_end_matches('/'));
    for _ in 0..40 {
        if let Ok(response) = reqwest::get(&url).await {
            if let Ok(response) = response.error_for_status() {
                if let Ok(body) = response.json::<NextNoteIdResponse>().await {
                    if body.next_note_id >= target {
                        return Ok(());
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    anyhow::bail!("timed out waiting for the public indexer to observe note {note_id}")
}

fn read_note_expiry(manifest: &DeploymentManifest, note_id: u32) -> anyhow::Result<u64> {
    let note_id = note_id.to_string();
    let output = Command::new("cast")
        .args([
            "call",
            "--rpc-url",
            &manifest.rpc_url,
            "--json",
            &manifest.contract_address,
            "notes(uint32)(bytes32,uint128,uint64,uint8)",
            &note_id,
        ])
        .output()
        .map_err(|err| {
            anyhow::anyhow!("failed to run cast; install Foundry's cast command: {err}")
        })?;
    if !output.status.success() {
        anyhow::bail!(
            "cast could not read the deposited note: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let values: Vec<Value> = serde_json::from_slice(&output.stdout)
        .map_err(|err| anyhow::anyhow!("cast returned invalid note JSON: {err}"))?;
    values
        .get(2)
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("vault note getter returned no expiry timestamp"))
}

struct EphemeralCastSigner {
    _keystore_dir: tempfile::TempDir,
    keystore_path: PathBuf,
    password: Zeroizing<String>,
    address: String,
}

fn create_ephemeral_cast_signer() -> anyhow::Result<EphemeralCastSigner> {
    let keystore_dir = tempfile::Builder::new()
        .prefix("zkapi-cast-signer-")
        .tempdir()
        .map_err(|error| anyhow::anyhow!("failed to create temporary cast keystore: {error}"))?;
    let mut password_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut password_bytes);
    let password = Zeroizing::new(hex::encode(password_bytes));
    password_bytes.fill(0);

    eprintln!(
        "Enter the depositor private key once. It will be cached only in a temporary encrypted keystore for this funding flow."
    );
    let output = Command::new("cast")
        .args(["wallet", "import", "zkapi-funding", "--keystore-dir"])
        .arg(keystore_dir.path())
        .arg("--interactive")
        .env("CAST_UNSAFE_PASSWORD", password.as_str())
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .output()
        .map_err(|err| {
            anyhow::anyhow!("failed to run cast; install Foundry's cast command: {err}")
        })?;
    if !output.status.success() {
        anyhow::bail!("cast could not import the temporary funding signer")
    }

    let import_output = String::from_utf8(output.stdout)
        .map_err(|error| anyhow::anyhow!("cast returned non-UTF-8 import output: {error}"))?;
    let address = import_output
        .lines()
        .find_map(|line| {
            line.split_once("Address:")
                .map(|(_, address)| address.trim())
        })
        .ok_or_else(|| anyhow::anyhow!("cast did not report the imported wallet address"))?;
    let address = normalize_address(address)?;

    let mut keystore_files = std::fs::read_dir(keystore_dir.path())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    if keystore_files.len() != 1 {
        anyhow::bail!(
            "cast created {} temporary keystore files; expected exactly one",
            keystore_files.len()
        );
    }
    let keystore_path = keystore_files.remove(0);
    eprintln!("Temporary cast signer ready for {address}.");

    Ok(EphemeralCastSigner {
        _keystore_dir: keystore_dir,
        keystore_path,
        password,
        address,
    })
}

fn run_cast_signed(signer: &EphemeralCastSigner, args: &[String]) -> anyhow::Result<()> {
    let (subcommand, arguments) = args
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("cast transaction command is empty"))?;
    let status = Command::new("cast")
        .arg(subcommand)
        .arg("--keystore")
        .arg(&signer.keystore_path)
        .arg("--password")
        .arg(signer.password.as_str())
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|err| {
            anyhow::anyhow!("failed to run cast; install Foundry's cast command: {err}")
        })?;
    if !status.success() {
        anyhow::bail!("cast transaction failed")
    }
    Ok(())
}

fn normalize_address(value: &str) -> anyhow::Result<String> {
    Ok(format!("0x{}", hex::encode(parse_destination(value)?)))
}

fn felt_as_bytes32(value: &Felt252) -> String {
    format!("0x{:0>64}", value.to_string().trim_start_matches("0x"))
}

fn felt_array_argument(values: &[Felt252]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn default_client_state_dir(deployment_id: &str) -> PathBuf {
    let state_root = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|path| path.join(".local").join("state"))
        })
        .unwrap_or_else(|| PathBuf::from("."));
    let safe_id: String = deployment_id
        .chars()
        .map(|character| match character {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' => character,
            _ => '_',
        })
        .collect();
    state_root.join("zkapi").join(safe_id)
}

fn ensure_private_state_dir(path: &std::path::Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(path).map_err(|err| {
        anyhow::anyhow!("failed to create state directory {}: {err}", path.display())
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|err| {
            anyhow::anyhow!("failed to secure state directory {}: {err}", path.display())
        })?;
    }
    Ok(())
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
        // CLI `client_config` only backs the local-only `keygen` command,
        // which does not generate request or withdrawal proofs.
        proof_mode: ClientProofMode::Groth16 {
            setup_dir: cli.proof_setup_dir.clone(),
        },
        trusted_epoch_roots: Vec::new(),
        state_signing_key: parse_curve_point(
            "state signing key",
            &cli.state_signing_key_x,
            &cli.state_signing_key_y,
        )?,
        clearance_signing_key: parse_curve_point(
            "clearance signing key",
            &cli.clearance_signing_key_x,
            &cli.clearance_signing_key_y,
        )?,
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

fn parse_curve_point(label: &str, x: &str, y: &str) -> anyhow::Result<CurvePointWire> {
    Ok(CurvePointWire {
        x: parse_felt(&format!("{label} x"), x)?,
        y: parse_felt(&format!("{label} y"), y)?,
    })
}

fn resolve_secret(cli_value: Option<String>, env_value: Option<String>) -> Option<String> {
    cli_value.or(env_value).filter(|value| !value.is_empty())
}

fn load_trusted_epoch_roots(path: Option<&std::path::Path>) -> anyhow::Result<Vec<EpochRoots>> {
    let Some(path) = path else {
        return Ok(Vec::new());
    };
    let bytes = std::fs::read(path).map_err(|err| {
        anyhow::anyhow!(
            "failed to read trusted epoch roots from {}: {err}",
            path.display()
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|err| {
        anyhow::anyhow!(
            "failed to parse trusted epoch roots from {}: {err}",
            path.display()
        )
    })
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

impl From<ClientModeArg> for RequestMode {
    fn from(value: ClientModeArg) -> Self {
        match value {
            ClientModeArg::Proxy => RequestMode::Proxy,
            ClientModeArg::DirectOpenrouter => RequestMode::DirectOpenrouter,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_secret_prefers_cli_and_ignores_empty_values() {
        assert_eq!(
            resolve_secret(
                Some("cli-secret".to_string()),
                Some("env-secret".to_string())
            ),
            Some("cli-secret".to_string())
        );
        assert_eq!(
            resolve_secret(None, Some("env-secret".to_string())),
            Some("env-secret".to_string())
        );
        assert_eq!(resolve_secret(None, Some(String::new())), None);
    }

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
            "--trusted-epoch-roots",
            "/tmp/trusted-roots.json",
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
        assert_eq!(
            cli.trusted_epoch_roots,
            Some(PathBuf::from("/tmp/trusted-roots.json"))
        );

        match cli.command {
            Commands::Clientd { listen, .. } => assert_eq!(listen, "127.0.0.1:11435"),
            other => panic!("expected clientd command, got {other:?}"),
        }
    }

    #[test]
    fn cli_parses_one_command_client_options() {
        let cli = Cli::try_parse_from([
            "zkapi",
            "client",
            "--deployment",
            "https://example.test/config.json",
            "--address",
            "0x1111111111111111111111111111111111111111",
            "--state-dir",
            "/tmp/one-command-wallet",
            "--listen",
            "127.0.0.1:11499",
            "--initial-credits",
            "42",
            "--skip-mint",
        ])
        .expect("client parse");

        match cli.command {
            Commands::Client {
                deployment,
                address,
                state_dir,
                listen,
                initial_credits,
                no_fund,
                fund_with_cast,
                skip_mint,
                mode,
            } => {
                assert_eq!(deployment, "https://example.test/config.json");
                assert_eq!(
                    address.as_deref(),
                    Some("0x1111111111111111111111111111111111111111")
                );
                assert_eq!(state_dir, Some(PathBuf::from("/tmp/one-command-wallet")));
                assert_eq!(listen, "127.0.0.1:11499");
                assert_eq!(initial_credits, 42);
                assert!(!no_fund);
                assert!(!fund_with_cast);
                assert!(skip_mint);
                assert!(matches!(mode, ClientModeArg::Proxy));
            }
            other => panic!("expected client command, got {other:?}"),
        }
    }

    #[test]
    fn one_command_client_defaults_to_mainnet_with_minimum_deposit() {
        let cli = Cli::try_parse_from(["zkapi", "client"]).expect("client parse");

        match cli.command {
            Commands::Client {
                deployment,
                initial_credits,
                fund_with_cast,
                ..
            } => {
                assert_eq!(deployment, PUBLIC_MAINNET_MANIFEST);
                assert_eq!(initial_credits, 2_000_000);
                assert!(!fund_with_cast);
            }
            other => panic!("expected client command, got {other:?}"),
        }
    }

    #[test]
    fn headless_cast_funding_is_explicit_opt_in() {
        let cli = Cli::try_parse_from(["zkapi", "client", "--fund-with-cast"])
            .expect("cast funding flag parses");
        assert!(matches!(
            cli.command,
            Commands::Client {
                fund_with_cast: true,
                ..
            }
        ));
    }

    #[test]
    fn client_accepts_prompt_private_openrouter_mode() {
        let cli = Cli::try_parse_from([
            "zkapi",
            "client",
            "--mode",
            "direct-openrouter",
            "--no-fund",
        ])
        .expect("direct mode parses");
        assert!(matches!(
            cli.command,
            Commands::Client {
                mode: ClientModeArg::DirectOpenrouter,
                ..
            }
        ));
    }

    #[test]
    fn withdraw_defaults_to_managed_mainnet_mutual_close() {
        let cli = Cli::try_parse_from([
            "zkapi",
            "withdraw",
            "--destination",
            "0x1111111111111111111111111111111111111111",
        ])
        .unwrap();
        match cli.command {
            Commands::Withdraw {
                destination,
                mode,
                deployment,
                client_url,
                note_id,
                dry_run,
            } => {
                assert_eq!(
                    destination.as_deref(),
                    Some("0x1111111111111111111111111111111111111111")
                );
                assert_eq!(mode, WithdrawalModeArg::Mutual);
                assert_eq!(deployment, PUBLIC_MAINNET_MANIFEST);
                assert_eq!(client_url, "http://127.0.0.1:11434");
                assert_eq!(note_id, None);
                assert!(!dry_run);
            }
            other => panic!("expected withdraw command, got {other:?}"),
        }
    }

    #[test]
    fn withdraw_accepts_escape_finalization() {
        let cli = Cli::try_parse_from([
            "zkapi",
            "withdraw",
            "--mode",
            "finalize-escape",
            "--note-id",
            "7",
            "--deployment",
            "sepolia.json",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Commands::Withdraw {
                mode: WithdrawalModeArg::FinalizeEscape,
                note_id: Some(7),
                ..
            }
        ));
    }

    #[test]
    fn server_accepts_independent_openrouter_management_key() {
        let cli = Cli::try_parse_from([
            "zkapi",
            "serverd",
            "--openrouter-management-key",
            "management-secret",
            "--openrouter-lease-ttl-seconds",
            "120",
        ])
        .expect("lease config parses");
        assert!(matches!(
            cli.command,
            Commands::Serverd {
                openrouter_management_key: Some(_),
                openrouter_lease_ttl_seconds: 120,
                ..
            }
        ));
    }

    #[test]
    fn server_accepts_oa_org_url() {
        let cli = Cli::try_parse_from([
            "zkapi",
            "serverd",
            "--oa-org-url",
            "https://org.example",
            "--openrouter-lease-ttl-seconds",
            "300",
        ])
        .expect("OA org lease config parses");
        assert!(matches!(
            cli.command,
            Commands::Serverd {
                oa_org_url: Some(_),
                openrouter_lease_ttl_seconds: 300,
                ..
            }
        ));
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
    fn cli_rejects_removed_openrouter_provisioning_options() {
        for option in ["--openrouter-key", "--ephemeral-limit-usd"] {
            let result = Cli::try_parse_from([
                "zkapi",
                "--contract-address",
                "0xdeadbeef",
                "serverd",
                "--provider",
                "metered",
                option,
                "test-value",
            ]);
            assert!(result.is_err(), "removed option {option} was accepted");
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

    #[test]
    fn withdrawal_control_url_is_loopback_only() {
        assert_eq!(
            local_client_endpoint("http://127.0.0.1:11434", "/wallet/settle").unwrap(),
            "http://127.0.0.1:11434/wallet/settle"
        );
        assert!(local_client_endpoint("https://example.com", "/wallet/settle").is_err());
        assert!(
            local_client_endpoint("http://127.0.0.1:11434@evil.test", "/wallet/settle").is_err()
        );
    }

    #[test]
    fn bytes32_and_array_arguments_are_cast_compatible() {
        let felt = Felt252::from_hex("0x1").unwrap();
        assert_eq!(
            felt_as_bytes32(&felt),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        assert_eq!(felt_array_argument(&[felt]), "[0x1]");
    }

    #[test]
    fn initial_deposit_reserves_one_maximum_cost_request() {
        assert_eq!(minimum_initial_credits(1_000_000).unwrap(), 2_000_000);
        assert!(minimum_initial_credits(0).is_err());
        assert!(minimum_initial_credits(u128::MAX).is_err());
    }

    #[test]
    fn broad_info_logging_does_not_enable_r1cs_spans() {
        use tracing_subscriber::prelude::*;

        let subscriber = tracing_subscriber::registry().with(suppress_r1cs_info(
            tracing_subscriber::EnvFilter::new("info"),
        ));
        tracing::subscriber::with_default(subscriber, || {
            assert!(!tracing::enabled!(target: "r1cs", tracing::Level::INFO));
            assert!(tracing::enabled!(target: "zkapi", tracing::Level::INFO));
        });
    }

    #[test]
    fn deployment_manifest_rejects_non_v2_backends() {
        let manifest = DeploymentManifest {
            deployment_id: "test".to_string(),
            protocol_version: 1,
            chain_id: 11155111,
            rpc_url: "https://rpc.example".to_string(),
            contract_address: "0x1".to_string(),
            billing_token_address: Some("0x2".to_string()),
            demo_mint_enabled: false,
            protocol_server_url: "https://server.example".to_string(),
            indexer_url: "https://indexer.example".to_string(),
            request_charge_cap: 1,
            proof_backend: "stwo_scarb".to_string(),
            state_signing_key: DeploymentCurvePoint {
                x: "0x1".to_string(),
                y: "0x2".to_string(),
            },
            clearance_signing_key: DeploymentCurvePoint {
                x: "0x3".to_string(),
                y: "0x4".to_string(),
            },
            models: Vec::new(),
        };
        assert!(validate_deployment_manifest(&manifest).is_err());
    }

    #[test]
    fn deployment_manifest_requires_an_explicit_demo_mint_flag() {
        let base = serde_json::json!({
            "deployment_id": "mainnet-test",
            "protocol_version": 2,
            "chain_id": 1,
            "rpc_url": "https://rpc.example",
            "contract_address": "0x1",
            "billing_token_address": "0x2",
            "protocol_server_url": "https://server.example",
            "indexer_url": "https://indexer.example",
            "request_charge_cap": 1_000_000,
            "proof_backend": "groth16_bn254",
            "state_signing_key": {"x": "0x1", "y": "0x2"},
            "clearance_signing_key": {"x": "0x3", "y": "0x4"}
        });
        let production: DeploymentManifest = serde_json::from_value(base.clone()).unwrap();
        assert!(!production.demo_mint_enabled);

        let mut demo = base;
        demo["demo_mint_enabled"] = serde_json::Value::Bool(true);
        let demo: DeploymentManifest = serde_json::from_value(demo).unwrap();
        assert!(demo.demo_mint_enabled);
    }
}
