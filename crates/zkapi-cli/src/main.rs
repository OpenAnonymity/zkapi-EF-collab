use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand, ValueEnum};
use serde::Deserialize;
use serde_json::Value;
use zkapi_client::config::{ClientConfig, ClientProofMode};
use zkapi_client::wallet::Wallet;
use zkapi_clientd::{
    run, AuthConfig, AuthService, ConfirmDepositRequest, CoreRequest, ModelDescriptor,
    WithdrawalMode,
};
use zkapi_serverd::config::{MeteredConfig, ProviderKind, ServerConfig};
use zkapi_types::wire::CurvePointWire;
use zkapi_types::{EpochRoots, Felt252};

const PUBLIC_SEPOLIA_MANIFEST: &str = "https://d33l4w2z2nh4cg.cloudfront.net/config.json";

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
    demo_private_key: Option<String>,
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
    },
    /// Start a ready-to-use local OpenAI/Ollama-compatible client.
    ///
    /// By default this loads the public Sepolia deployment, funds a new demo
    /// note only when the selected local state directory has no active note,
    /// then listens on 127.0.0.1:11434.
    Client {
        /// Deployment manifest URL or local JSON path.
        #[arg(long, default_value = PUBLIC_SEPOLIA_MANIFEST)]
        deployment: String,
        /// Depositor address to fund. Omit to let cast derive it interactively.
        #[arg(long)]
        address: Option<String>,
        /// Local HTTP address for OpenAI, Responses, and Ollama-compatible APIs.
        #[arg(long, default_value = "127.0.0.1:11434")]
        listen: String,
        /// Private wallet state directory. Defaults to a deployment-specific user state path.
        #[arg(long)]
        state_dir: Option<PathBuf>,
        /// Credits to mint and deposit when the client has no active note.
        #[arg(long, default_value_t = 5_000_000)]
        initial_credits: u128,
        /// Start without funding when no active note exists.
        #[arg(long)]
        no_fund: bool,
        /// Do not call the public demo token's faucet-style mint method.
        #[arg(long)]
        skip_mint: bool,
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
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
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
        Commands::Clientd { listen } => {
            let service = build_auth_service(&cli)?;
            run(service, &listen).await?
        }
        Commands::Client {
            deployment,
            address,
            listen,
            state_dir,
            initial_credits,
            no_fund,
            skip_mint,
        } => {
            run_one_command_client(
                &deployment,
                address.as_deref(),
                &listen,
                state_dir,
                initial_credits,
                no_fund,
                skip_mint,
            )
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
    })
    .map_err(Into::into)
}

/// Start the local compatibility daemon from a published public deployment
/// manifest. This is the low-friction entrypoint: no caller has to repeat the
/// deployment's addresses, chain parameters, proving setup, or server keys.
async fn run_one_command_client(
    deployment: &str,
    requested_address: Option<&str>,
    listen: &str,
    requested_state_dir: Option<PathBuf>,
    initial_credits: u128,
    no_fund: bool,
    skip_mint: bool,
) -> anyhow::Result<()> {
    let manifest = load_deployment_manifest(deployment).await?;
    validate_deployment_manifest(&manifest)?;

    let state_dir =
        requested_state_dir.unwrap_or_else(|| default_client_state_dir(&manifest.deployment_id));
    ensure_private_state_dir(&state_dir)?;
    let service = auth_service_from_manifest(&manifest, state_dir.clone(), listen)?;

    if !service.status().await?.has_note {
        if no_fund {
            eprintln!(
                "No active zkAPI note in {}. Starting without funding; requests will return 402 until funded.",
                state_dir.display()
            );
        } else {
            eprintln!(
                "No active zkAPI note in {}. Funding {} demo credits now; cast will securely prompt for the wallet key.",
                state_dir.display(),
                initial_credits
            );
            fund_public_demo(
                &service,
                &manifest,
                requested_address,
                initial_credits,
                skip_mint,
            )
            .await?;
        }
    }

    println!("zkAPI local gateway: http://{listen}");
    println!("  OpenAI Chat Completions: http://{listen}/v1/chat/completions");
    println!("  OpenAI Responses:        http://{listen}/v1/responses");
    println!("  Ollama Chat:              http://{listen}/api/chat");
    println!("  Models:                   http://{listen}/v1/models");

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
) -> anyhow::Result<Arc<AuthService>> {
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
        demo_rpc_url: Some(manifest.rpc_url.clone()),
        demo_billing_token_address: manifest.billing_token_address.clone(),
        demo_private_key: None,
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
    })
    .map_err(Into::into)
}

/// Create, submit, and confirm the first note with only terminal prompts from
/// Foundry's `cast`. The key never enters our argument parser or state files.
async fn fund_public_demo(
    service: &Arc<AuthService>,
    manifest: &DeploymentManifest,
    requested_address: Option<&str>,
    amount: u128,
    skip_mint: bool,
) -> anyhow::Result<()> {
    if amount < manifest.request_charge_cap {
        anyhow::bail!(
            "initial credits {amount} are below this deployment's per-request proof bound {}; choose --initial-credits at least that large",
            manifest.request_charge_cap
        );
    }
    let token = manifest.billing_token_address.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "deployment {} has no billing token. Native ETH funding requires a separate native-asset vault deployment; this v2 vault accepts its configured ERC-20 token.",
            manifest.deployment_id
        )
    })?;
    let address = match requested_address {
        Some(address) => {
            let requested = normalize_address(address)?;
            let signer = cast_interactive_address()?;
            if signer != requested {
                anyhow::bail!(
                    "--address {requested} does not match the private key's address {signer}"
                );
            }
            requested
        }
        None => cast_interactive_address()?,
    };
    let plan = service.prepare_deposit(amount).await?;
    let amount = plan.amount.to_string();
    let commitment = felt_as_bytes32(&plan.commitment);
    let siblings = felt_array_argument(&plan.zero_path);
    let note_id = plan.next_note_id;

    if !skip_mint {
        run_cast_interactive(&[
            "send".to_string(),
            "--rpc-url".to_string(),
            manifest.rpc_url.clone(),
            "--interactive".to_string(),
            token.to_string(),
            "mint(address,uint256)".to_string(),
            address.clone(),
            amount.clone(),
        ])?;
    }
    run_cast_interactive(&[
        "send".to_string(),
        "--rpc-url".to_string(),
        manifest.rpc_url.clone(),
        "--interactive".to_string(),
        token.to_string(),
        "approve(address,uint256)".to_string(),
        manifest.contract_address.clone(),
        amount.clone(),
    ])?;
    run_cast_interactive(&[
        "send".to_string(),
        "--rpc-url".to_string(),
        manifest.rpc_url.clone(),
        "--interactive".to_string(),
        manifest.contract_address.clone(),
        "deposit(bytes32,uint128,uint256[32])".to_string(),
        commitment,
        amount.clone(),
        siblings,
    ])?;

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

fn cast_interactive_address() -> anyhow::Result<String> {
    eprintln!("No --address supplied. cast will prompt for the depositor private key to derive its address.");
    let output = Command::new("cast")
        .args(["wallet", "address", "--interactive"])
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .output()
        .map_err(|err| {
            anyhow::anyhow!("failed to run cast; install Foundry's cast command: {err}")
        })?;
    if !output.status.success() {
        anyhow::bail!("cast could not derive a wallet address")
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|err| anyhow::anyhow!("cast returned a non-UTF-8 address: {err}"))?;
    let address = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("cast did not return a wallet address"))?;
    normalize_address(address)
}

fn run_cast_interactive(args: &[String]) -> anyhow::Result<()> {
    let status = Command::new("cast")
        .args(args)
        .stdin(Stdio::inherit())
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
            Commands::Clientd { listen } => assert_eq!(listen, "127.0.0.1:11435"),
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
                skip_mint,
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
                assert!(skip_mint);
            }
            other => panic!("expected client command, got {other:?}"),
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
    fn bytes32_and_array_arguments_are_cast_compatible() {
        let felt = Felt252::from_hex("0x1").unwrap();
        assert_eq!(
            felt_as_bytes32(&felt),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        assert_eq!(felt_array_argument(&[felt]), "[0x1]");
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
}
