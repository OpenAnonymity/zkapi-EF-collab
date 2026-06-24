//! Axum HTTP routes for the zkAPI server.
//!
//! Endpoints:
//! - GET  /health                   -- process health and config summary
//! - GET  /v1/attestation           -- published signer metadata for deployments
//! - POST /v1/requests              -- submit an API request
//! - POST /v1/withdraw/clearance    -- request mutual-close clearance
//! - GET  /v1/requests/:id          -- recover by client_request_id
//! - GET  /v1/nullifiers/:nullifier -- recover by nullifier

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;

use zkapi_core::poseidon::felt_to_field;
use zkapi_types::wire::{
    ApiRequest, ClearanceRequest, ClearanceResponse, ErrorResponse, RecoveryResponse,
    RequestResponse,
};
use zkapi_types::Felt252;

use crate::error::ServerError;
use crate::processor::RequestProcessor;
use crate::provider::build_provider;

/// Shared application state.
type AppState = Arc<RequestProcessor>;

/// Start the HTTP server with the given config.
pub async fn run_server(config: crate::config::ServerConfig) -> anyhow::Result<()> {
    let store = Arc::new(crate::nullifier_store::NullifierStore::new(
        &config.db_path,
    )?);
    let signer = Arc::new(crate::signer::ServerSigner::with_height(
        felt_to_field(&config.state_seed),
        felt_to_field(&config.clear_seed),
        config.epoch,
        config.xmss_height,
    ));
    let provider = build_provider(&config)?;
    let initial_root = if let Some(indexer_url) = config.indexer_url.as_deref() {
        match fetch_indexer_root(indexer_url).await {
            Ok(root) => root,
            Err(err) => {
                tracing::warn!("failed to fetch initial root from indexer: {}", err);
                config.initial_root
            }
        }
    } else {
        config.initial_root
    };
    let processor = Arc::new(RequestProcessor::new(
        config.clone(),
        store,
        signer,
        provider,
        initial_root,
    ));
    if let Some(indexer_url) = config.indexer_url.clone() {
        spawn_root_poller(
            processor.clone(),
            indexer_url,
            Duration::from_millis(config.root_poll_interval_ms),
        );
    }
    let router = create_router(processor);
    let listener = tokio::net::TcpListener::bind(&config.listen_addr).await?;
    tracing::info!("Server listening on {}", config.listen_addr);
    axum::serve(listener, router).await?;
    Ok(())
}

/// Create the Axum router with all zkAPI server routes.
pub fn create_router(processor: Arc<RequestProcessor>) -> Router {
    Router::new()
        .route("/", get(handle_health))
        .route("/health", get(handle_health))
        .route("/v1/attestation", get(handle_attestation))
        .route("/v1/requests", post(handle_request))
        .route("/v1/withdraw/clearance", post(handle_clearance))
        .route(
            "/v1/requests/{client_request_id}",
            get(handle_recovery_by_id),
        )
        .route(
            "/v1/nullifiers/{nullifier}",
            get(handle_recovery_by_nullifier),
        )
        .with_state(processor)
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    protocol_version: u16,
    chain_id: u64,
    contract_address: Felt252,
    current_root: Felt252,
    provider: &'static str,
    indexer_url: Option<String>,
    policy_enabled: bool,
    auth_scheme: &'static str,
}

#[derive(Debug, Serialize)]
struct AttestationResponse {
    status: &'static str,
    protocol_version: u16,
    chain_id: u64,
    contract_address: Felt252,
    current_root: Felt252,
    state_sig_epoch: u32,
    clear_sig_epoch: u32,
    state_sig_root: Felt252,
    clear_sig_root: Felt252,
    state_signatures_remaining: u32,
    clear_signatures_remaining: u32,
    auth_scheme: &'static str,
}

async fn handle_health(State(processor): State<AppState>) -> Json<HealthResponse> {
    let config = processor.config();
    Json(HealthResponse {
        status: "ok",
        protocol_version: config.protocol_version,
        chain_id: config.chain_id,
        contract_address: config.contract_address,
        current_root: processor.current_root(),
        provider: provider_name(config.provider_kind),
        indexer_url: config.indexer_url.clone(),
        policy_enabled: config.policy_enabled,
        auth_scheme: config.auth_scheme.as_str(),
    })
}

async fn handle_attestation(State(processor): State<AppState>) -> Json<AttestationResponse> {
    let config = processor.config();
    Json(AttestationResponse {
        status: "ok",
        protocol_version: config.protocol_version,
        chain_id: config.chain_id,
        contract_address: config.contract_address,
        current_root: processor.current_root(),
        state_sig_epoch: processor.state_sig_epoch(),
        clear_sig_epoch: processor.clear_sig_epoch(),
        state_sig_root: processor.state_sig_root(),
        clear_sig_root: processor.clear_sig_root(),
        state_signatures_remaining: processor.state_signatures_remaining(),
        clear_signatures_remaining: processor.clear_signatures_remaining(),
        auth_scheme: config.auth_scheme.as_str(),
    })
}

/// POST /v1/requests -- process an API request.
async fn handle_request(
    State(processor): State<AppState>,
    Json(api_request): Json<ApiRequest>,
) -> Result<Json<RequestResponse>, (StatusCode, Json<ErrorResponse>)> {
    processor
        .process_request(&api_request)
        .await
        .map(Json)
        .map_err(|e| error_to_response(&e, &api_request.client_request_id, &processor))
}

/// POST /v1/withdraw/clearance -- request a clearance signature.
async fn handle_clearance(
    State(processor): State<AppState>,
    Json(clearance_req): Json<ClearanceRequest>,
) -> Result<Json<ClearanceResponse>, (StatusCode, Json<ErrorResponse>)> {
    processor
        .process_clearance(&clearance_req)
        .map(Json)
        .map_err(|e| {
            error_to_response(&e, &clearance_req.withdrawal_nullifier.to_hex(), &processor)
        })
}

/// GET /v1/requests/:client_request_id -- recover a response by client request ID.
async fn handle_recovery_by_id(
    State(processor): State<AppState>,
    Path(client_request_id): Path<String>,
) -> Result<Json<RecoveryResponse>, (StatusCode, Json<ErrorResponse>)> {
    processor
        .recover_by_client_id(&client_request_id)
        .map(Json)
        .map_err(|e| error_to_response(&e, &client_request_id, &processor))
}

/// GET /v1/nullifiers/:nullifier -- recover a response by nullifier hex.
async fn handle_recovery_by_nullifier(
    State(processor): State<AppState>,
    Path(nullifier_hex): Path<String>,
) -> Result<Json<RecoveryResponse>, (StatusCode, Json<ErrorResponse>)> {
    let nullifier = Felt252::from_hex(&nullifier_hex).map_err(|e| {
        let err = ServerError::InvalidRequest(format!("invalid nullifier hex: {}", e));
        error_to_response(&err, &nullifier_hex, &processor)
    })?;

    processor
        .recover_by_nullifier(&nullifier)
        .map(Json)
        .map_err(|e| error_to_response(&e, &nullifier_hex, &processor))
}

/// Convert a ServerError into an HTTP error response tuple.
fn error_to_response(
    err: &ServerError,
    client_request_id: &str,
    processor: &RequestProcessor,
) -> (StatusCode, Json<ErrorResponse>) {
    let status_code = match err {
        ServerError::InvalidProof(_)
        | ServerError::InvalidRequest(_)
        | ServerError::ProtocolMismatch(_) => StatusCode::BAD_REQUEST,
        ServerError::StaleRoot { .. } => StatusCode::CONFLICT,
        ServerError::Replay | ServerError::NullifierUsed => StatusCode::CONFLICT,
        ServerError::NoteExpired => StatusCode::GONE,
        ServerError::CapacityExhausted => StatusCode::SERVICE_UNAVAILABLE,
        ServerError::Internal(_) | ServerError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };

    let latest_root = if matches!(err, ServerError::StaleRoot { .. }) {
        Some(processor.current_root())
    } else {
        None
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let body = ErrorResponse {
        status: "error".to_string(),
        client_request_id: client_request_id.to_string(),
        error_code: err.error_code().to_string(),
        error_message: err.to_string(),
        retriable: err.is_retriable(),
        latest_root,
        server_time_ms: Some(now_ms),
    };

    (status_code, Json(body))
}

fn spawn_root_poller(processor: Arc<RequestProcessor>, indexer_url: String, interval: Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            match fetch_indexer_root(&indexer_url).await {
                Ok(root) => processor.update_root(root),
                Err(err) => tracing::warn!("failed to refresh root from indexer: {}", err),
            }
        }
    });
}

fn provider_name(provider_kind: crate::config::ProviderKind) -> &'static str {
    match provider_kind {
        crate::config::ProviderKind::Echo => "echo",
        crate::config::ProviderKind::HttpProxy => "http-proxy",
    }
}

async fn fetch_indexer_root(indexer_url: &str) -> anyhow::Result<Felt252> {
    #[derive(serde::Deserialize)]
    struct RootResponse {
        root: Felt252,
    }

    let base = indexer_url.trim_end_matches('/');
    let url = format!("{base}/v1/tree/root");
    let response = reqwest::get(&url).await?;
    let response = response.error_for_status()?;
    Ok(response.json::<RootResponse>().await?.root)
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::routing::get;
    use axum::Router;
    use zkapi_core::poseidon::FieldElement;

    use crate::config::{ProviderKind, ServerConfig};
    use crate::nullifier_store::NullifierStore;
    use crate::provider::EchoProvider;
    use crate::signer::ServerSigner;

    fn test_processor() -> Arc<RequestProcessor> {
        let config = ServerConfig {
            protocol_version: 3,
            chain_id: 55,
            contract_address: Felt252::from_u64(1234),
            provider_kind: ProviderKind::Echo,
            echo_fixed_charge: 7,
            indexer_url: Some("http://127.0.0.1:3001".to_string()),
            ..Default::default()
        };
        Arc::new(RequestProcessor::new(
            config,
            Arc::new(NullifierStore::in_memory().unwrap()),
            Arc::new(ServerSigner::with_height(
                FieldElement::from(11u64),
                FieldElement::from(13u64),
                9,
                6,
            )),
            Arc::new(EchoProvider::new(7)),
            Felt252::from_u64(99),
        ))
    }

    #[tokio::test]
    async fn test_fetch_indexer_root() {
        async fn root() -> Json<serde_json::Value> {
            Json(serde_json::json!({
                "root": Felt252::from_u64(77),
            }))
        }

        let app = Router::new().route("/v1/tree/root", get(root));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let root = fetch_indexer_root(&format!("http://{}", addr))
            .await
            .unwrap();
        assert_eq!(root, Felt252::from_u64(77));
    }

    #[tokio::test]
    async fn test_health_route_reports_runtime_config() {
        let app = create_router(test_processor());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::get(format!("http://{}/health", addr))
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();

        assert_eq!(response["status"], "ok");
        assert_eq!(response["protocol_version"], 3);
        assert_eq!(response["chain_id"], 55);
        assert_eq!(response["provider"], "echo");
        assert_eq!(response["current_root"], Felt252::from_u64(99).to_hex());
    }

    #[tokio::test]
    async fn test_attestation_route_reports_signer_metadata() {
        let app = create_router(test_processor());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::get(format!("http://{}/v1/attestation", addr))
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();

        assert_eq!(response["status"], "ok");
        assert_eq!(response["state_sig_epoch"], 9);
        assert_eq!(response["clear_sig_epoch"], 9);
        assert_eq!(response["current_root"], Felt252::from_u64(99).to_hex());
        assert!(response["state_sig_root"].as_str().is_some());
        assert!(response["clear_sig_root"].as_str().is_some());
        assert!(response["state_signatures_remaining"].as_u64().unwrap() > 0);
        assert!(response["clear_signatures_remaining"].as_u64().unwrap() > 0);
    }
}
