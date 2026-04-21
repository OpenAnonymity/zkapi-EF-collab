//! Axum HTTP server for the tree indexer.

use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use zkapi_types::Felt252;

use crate::poller::{spawn_json_rpc_log_poller, PollerConfig};
use crate::service::{IndexerService, NextNoteIdResponse, TreePathResponse, TreeRootResponse};
use crate::tree_mirror::TreeMirror;

/// Runtime configuration for the indexer HTTP server.
#[derive(Debug, Clone)]
pub struct IndexerConfig {
    pub listen_addr: String,
    pub rpc_url: String,
    pub contract_address: String,
    pub from_block: u64,
    pub poll_interval_ms: u64,
    pub cursor_path: Option<String>,
}

impl Default for IndexerConfig {
    fn default() -> Self {
        let poller = PollerConfig::default();
        Self {
            listen_addr: "0.0.0.0:3001".to_string(),
            rpc_url: poller.rpc_url,
            contract_address: poller.contract_address,
            from_block: poller.from_block,
            poll_interval_ms: 1_000,
            cursor_path: poller.cursor_path,
        }
    }
}

type AppState = Arc<IndexerService>;

pub async fn run_indexer(config: IndexerConfig) -> anyhow::Result<()> {
    let service = Arc::new(IndexerService::new(Arc::new(
        RwLock::new(TreeMirror::new()),
    )));
    if !config.rpc_url.trim().is_empty() && !config.contract_address.trim().is_empty() {
        spawn_json_rpc_log_poller(
            service.clone(),
            PollerConfig {
                rpc_url: config.rpc_url,
                contract_address: config.contract_address,
                from_block: config.from_block,
                cursor_path: config.cursor_path,
            },
            Duration::from_millis(config.poll_interval_ms),
        );
    }

    let router = create_router(service);
    let listener = tokio::net::TcpListener::bind(&config.listen_addr).await?;
    tracing::info!("Indexer listening on {}", config.listen_addr);
    axum::serve(listener, router).await?;
    Ok(())
}

pub fn create_router(service: Arc<IndexerService>) -> Router {
    Router::new()
        .route("/health", get(handle_health))
        .route("/v1/tree/root", get(handle_root))
        .route("/v1/tree/next-note-id", get(handle_next_note_id))
        .route("/v1/tree/notes/{note_id}/path", get(handle_note_path))
        .route("/v1/tree/notes/{note_id}/zero-path", get(handle_zero_path))
        .with_state(service)
}

async fn handle_health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn handle_root(State(service): State<AppState>) -> Json<TreeRootResponse> {
    Json(TreeRootResponse {
        root: service.get_root(),
    })
}

async fn handle_next_note_id(State(service): State<AppState>) -> Json<NextNoteIdResponse> {
    Json(NextNoteIdResponse {
        next_note_id: service.get_next_note_id(),
    })
}

async fn handle_note_path(
    State(service): State<AppState>,
    Path(note_id): Path<u32>,
) -> Json<TreePathResponse> {
    Json(TreePathResponse {
        note_id,
        leaf: service.get_leaf(note_id),
        siblings: service.get_note_path(note_id).to_vec(),
    })
}

async fn handle_zero_path(
    State(service): State<AppState>,
    Path(note_id): Path<u32>,
) -> Json<TreePathResponse> {
    Json(TreePathResponse {
        note_id,
        leaf: Felt252::ZERO,
        siblings: service.get_zero_path(note_id).to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::events::VaultEvent;

    #[tokio::test]
    async fn test_zero_path_endpoint_returns_zero_leaf() {
        let service = Arc::new(IndexerService::new(Arc::new(
            RwLock::new(TreeMirror::new()),
        )));
        service.process_event(&VaultEvent::NoteDeposited {
            note_id: 0,
            commitment: Felt252::from_u64(10),
            amount: 100,
            expiry_ts: 1_700_000_000,
            new_root: Felt252::from_u64(1),
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = create_router(service);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::get(format!("http://{addr}/v1/tree/notes/0/zero-path"))
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<TreePathResponse>()
            .await
            .unwrap();

        assert_eq!(response.note_id, 0);
        assert_eq!(response.leaf, Felt252::ZERO);
    }
}
