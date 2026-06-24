//! Standalone `zkapi-indexerd` binary.
//!
//! Mirrors the same functionality as `zkapi indexer`, but as a first-class
//! daemon binary so it can be packaged into its own container image (Week 9).

use clap::Parser;
use zkapi_indexerd::{run_indexer, IndexerConfig};

#[derive(Debug, Parser)]
#[command(name = "zkapi-indexerd", about = "zkAPI on-chain indexer daemon")]
struct Args {
    /// HTTP listen address.
    #[arg(long, default_value = "0.0.0.0:3001")]
    listen: String,
    /// Ethereum JSON-RPC endpoint to poll.
    #[arg(long, default_value = "http://127.0.0.1:8545")]
    rpc_url: String,
    /// ZkApiVault contract address (0x-prefixed).
    #[arg(long)]
    contract_address: String,
    /// First block to scan from on a fresh start.
    #[arg(long, default_value_t = 0)]
    from_block: u64,
    /// Poll interval in milliseconds.
    #[arg(long, default_value_t = 1_000)]
    poll_interval_ms: u64,
    /// Path to persist the last-processed-block cursor across restarts.
    #[arg(long)]
    cursor_path: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args = Args::parse();
    run_indexer(IndexerConfig {
        listen_addr: args.listen,
        rpc_url: args.rpc_url,
        contract_address: args.contract_address,
        from_block: args.from_block,
        poll_interval_ms: args.poll_interval_ms,
        cursor_path: args.cursor_path,
    })
    .await
}
