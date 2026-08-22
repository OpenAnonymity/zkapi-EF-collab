//! Axum HTTP routes for the zkAPI server.
//!
//! Endpoints:
//! - GET  /health                   -- process health and config summary
//! - GET  /v1/attestation           -- published signer metadata for deployments
//! - POST /v2/requests              -- submit an API request
//! - POST /v2/openrouter/leases     -- open a prompt-private runtime-key lease
//! - POST /v2/openrouter/leases/:id -- retire a rejected runtime-key lease
//! - POST /v2/withdraw/clearance    -- request mutual-close clearance
//! - GET  /v2/requests/:id          -- recover by client_request_id
//! - GET  /v2/nullifiers/:nullifier -- recover by nullifier

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::header::RETRY_AFTER;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::Stream;
use serde::Serialize;
use tower_http::cors::CorsLayer;

use zkapi_types::wire::{
    ApiRequestV2, ClearanceRequest, ClearanceResponseV2, CurvePointWire, ErrorResponse,
    OpenRouterLeaseStatusResponse, RecoveryResponseV2, RequestResponseV2,
};
use zkapi_types::Felt252;

use crate::dashboard::{DashboardEvent, DashboardHub, DashboardTotals};
use crate::error::ServerError;
use crate::oa_org::IssuedOpenRouterLease;
use crate::pricing;
use crate::processor::RequestProcessor;
use crate::provider::build_provider;

/// Shared application state.
type AppState = Arc<RequestProcessor>;

type ErrorHttpResponse = (StatusCode, HeaderMap, Json<ErrorResponse>);

// Compact proofs are small; leave headroom for ordinary API payloads.
const PROTOCOL_BODY_LIMIT_BYTES: usize = 1024 * 1024;

/// Start the HTTP server with the given config.
pub async fn run_server(config: crate::config::ServerConfig) -> anyhow::Result<()> {
    let store = Arc::new(crate::nullifier_store::NullifierStore::new(
        &config.db_path,
    )?);
    let signer = Arc::new(crate::signer::ServerSigner::new(
        &config.state_seed,
        &config.clear_seed,
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
    let dashboard = Arc::new(DashboardHub::new(500));
    let processor = Arc::new(
        RequestProcessor::try_new(config.clone(), store, signer, provider, initial_root)?
            .with_dashboard(dashboard),
    );
    if let Some(indexer_url) = config.indexer_url.clone() {
        spawn_root_poller(
            processor.clone(),
            indexer_url,
            Duration::from_millis(config.root_poll_interval_ms),
        );
    }
    if let Some(lease) = config.openrouter_leases.as_ref() {
        spawn_openrouter_lease_settler(
            processor.clone(),
            Duration::from_secs(lease.settlement_poll_seconds.max(1)),
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
    // The dashboard is a separate local origin and only ever reads these three
    // routes, so cross-origin access is granted to THESE ONLY. The protocol
    // POST and the recovery GETs (which can return a stored transcript) get no
    // CORS, so a random web page can't read them cross-origin.
    let dashboard = Router::new()
        .route("/v1/dashboard/summary", get(handle_dashboard_summary))
        .route("/v1/dashboard/recent", get(handle_dashboard_recent))
        .route("/v1/dashboard/events", get(handle_dashboard_events))
        .layer(CorsLayer::very_permissive());

    Router::new()
        .route("/", get(handle_health))
        .route("/health", get(handle_health))
        .route("/v1/attestation", get(handle_attestation))
        .route("/v2/requests", post(handle_request))
        .route("/v2/openrouter/leases", post(handle_openrouter_lease))
        .route(
            "/v2/openrouter/leases/{client_request_id}",
            get(handle_openrouter_lease_status).post(handle_openrouter_lease_retirement),
        )
        .route("/v2/withdraw/clearance", post(handle_clearance))
        .route(
            "/v2/requests/{client_request_id}",
            get(handle_recovery_by_id),
        )
        .route(
            "/v2/nullifiers/{nullifier}",
            get(handle_recovery_by_nullifier),
        )
        .merge(dashboard)
        .layer(DefaultBodyLimit::max(PROTOCOL_BODY_LIMIT_BYTES))
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
    request_modes: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
struct AttestationResponse {
    status: &'static str,
    protocol_version: u16,
    chain_id: u64,
    contract_address: Felt252,
    current_root: Felt252,
    state_signing_key: CurvePointWire,
    clearance_signing_key: CurvePointWire,
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
        request_modes: if processor.openrouter_leases_enabled() {
            vec!["proxy", "direct_openrouter"]
        } else {
            vec!["proxy"]
        },
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
        state_signing_key: processor.state_signing_key(),
        clearance_signing_key: processor.clearance_signing_key(),
        auth_scheme: config.auth_scheme.as_str(),
    })
}

/// POST /v1/requests -- process an API request.
async fn handle_request(
    State(processor): State<AppState>,
    Json(api_request): Json<ApiRequestV2>,
) -> Result<Json<RequestResponseV2>, ErrorHttpResponse> {
    processor
        .process_request(&api_request)
        .await
        .map(Json)
        .map_err(|e| error_to_response(&e, &api_request.client_request_id, &processor))
}

async fn handle_openrouter_lease(
    State(processor): State<AppState>,
    Json(api_request): Json<ApiRequestV2>,
) -> Result<(StatusCode, Json<IssuedOpenRouterLease>), ErrorHttpResponse> {
    processor
        .issue_openrouter_lease(&api_request)
        .await
        .map(|response| (StatusCode::CREATED, Json(response)))
        .map_err(|error| error_to_response(&error, &api_request.client_request_id, &processor))
}

async fn handle_openrouter_lease_status(
    State(processor): State<AppState>,
    Path(client_request_id): Path<String>,
) -> Result<Json<OpenRouterLeaseStatusResponse>, StatusCode> {
    processor
        .openrouter_lease_status(&client_request_id)
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn handle_openrouter_lease_retirement(
    State(processor): State<AppState>,
    Path(client_request_id): Path<String>,
    Json(api_request): Json<ApiRequestV2>,
) -> Result<Json<OpenRouterLeaseStatusResponse>, ErrorHttpResponse> {
    processor
        .retire_openrouter_lease(&client_request_id, &api_request)
        .await
        .map(Json)
        .map_err(|error| error_to_response(&error, &client_request_id, &processor))
}

/// POST /v1/withdraw/clearance -- request a clearance signature.
async fn handle_clearance(
    State(processor): State<AppState>,
    Json(clearance_req): Json<ClearanceRequest>,
) -> Result<Json<ClearanceResponseV2>, ErrorHttpResponse> {
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
) -> Result<Json<RecoveryResponseV2>, ErrorHttpResponse> {
    processor
        .recover_by_client_id(&client_request_id)
        .map(Json)
        .map_err(|e| error_to_response(&e, &client_request_id, &processor))
}

/// GET /v1/nullifiers/:nullifier -- recover a response by nullifier hex.
async fn handle_recovery_by_nullifier(
    State(processor): State<AppState>,
    Path(nullifier_hex): Path<String>,
) -> Result<Json<RecoveryResponseV2>, ErrorHttpResponse> {
    let nullifier = Felt252::from_hex(&nullifier_hex).map_err(|e| {
        let err = ServerError::InvalidRequest(format!("invalid nullifier hex: {}", e));
        error_to_response(&err, &nullifier_hex, &processor)
    })?;

    processor
        .recover_by_nullifier(&nullifier)
        .map(Json)
        .map_err(|e| error_to_response(&e, &nullifier_hex, &processor))
}

/// Server identity + signing capacity for the dashboard header panel.
#[derive(Debug, Serialize)]
struct ServerIdentity {
    protocol_version: u16,
    chain_id: u64,
    contract_address: Felt252,
    current_root: Felt252,
    provider: &'static str,
    upstream_kind: Option<String>,
    upstream_api_base: Option<String>,
    auth_scheme: &'static str,
    policy_enabled: bool,
    request_charge_cap: u128,
    request_charge_cap_usd: f64,
    credits_per_usd: f64,
    state_signing_key: CurvePointWire,
    clearance_signing_key: CurvePointWire,
    openrouter_leases_enabled: bool,
}

#[derive(Debug, Serialize)]
struct DashboardSummary {
    server: ServerIdentity,
    totals: DashboardTotals,
    started_ms: u64,
    recent_count: usize,
}

/// GET /v1/dashboard/summary -- server identity + running totals.
async fn handle_dashboard_summary(State(processor): State<AppState>) -> Json<DashboardSummary> {
    let config = processor.config();
    let (upstream_kind, upstream_api_base) = match &config.metered {
        Some(m) => {
            let mut bases = Vec::new();
            if m.openai_api_key.is_some() {
                bases.push(format!("openai={}", m.openai_api_base));
            }
            if m.openrouter_inference_key.is_some() {
                bases.push(format!("openrouter={}", m.openrouter_api_base));
            }
            (Some(m.upstreams_label()), Some(bases.join(", ")))
        }
        None => (None, None),
    };
    let server = ServerIdentity {
        protocol_version: config.protocol_version,
        chain_id: config.chain_id,
        contract_address: config.contract_address,
        current_root: processor.current_root(),
        provider: provider_name(config.provider_kind),
        upstream_kind,
        upstream_api_base,
        auth_scheme: config.auth_scheme.as_str(),
        policy_enabled: config.policy_enabled,
        request_charge_cap: config.request_charge_cap,
        request_charge_cap_usd: pricing::credits_to_usd(config.request_charge_cap),
        credits_per_usd: pricing::CREDITS_PER_USD,
        state_signing_key: processor.state_signing_key(),
        clearance_signing_key: processor.clearance_signing_key(),
        openrouter_leases_enabled: processor.openrouter_leases_enabled(),
    };
    let (totals, started_ms, recent_count) = match processor.dashboard() {
        Some(hub) => (hub.totals(), hub.started_ms, hub.recent().len()),
        None => (DashboardTotals::default(), 0, 0),
    };
    Json(DashboardSummary {
        server,
        totals,
        started_ms,
        recent_count,
    })
}

/// GET /v1/dashboard/recent -- the recent request feed (newest last).
async fn handle_dashboard_recent(State(processor): State<AppState>) -> Json<Vec<DashboardEvent>> {
    let events = processor
        .dashboard()
        .map(|hub| hub.recent())
        .unwrap_or_default();
    Json(events)
}

/// GET /v1/dashboard/events -- Server-Sent-Events stream of live requests.
async fn handle_dashboard_events(
    State(processor): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = processor.dashboard().map(|hub| hub.subscribe());
    let stream = futures_util::stream::unfold(rx, |state| async move {
        let mut rx = state?;
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let data = serde_json::to_string(&event).unwrap_or_default();
                    let sse = Event::default().event("request").data(data);
                    return Some((Ok(sse), Some(rx)));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Convert a ServerError into an HTTP error response tuple.
fn error_to_response(
    err: &ServerError,
    client_request_id: &str,
    processor: &RequestProcessor,
) -> ErrorHttpResponse {
    let latest_root = if matches!(err, ServerError::StaleRoot { .. }) {
        Some(processor.current_root())
    } else {
        None
    };
    build_error_response(err, client_request_id, latest_root)
}

fn build_error_response(
    err: &ServerError,
    client_request_id: &str,
    latest_root: Option<Felt252>,
) -> ErrorHttpResponse {
    let status_code = match err {
        ServerError::InvalidProof(_)
        | ServerError::InvalidRequest(_)
        | ServerError::ProtocolMismatch(_) => StatusCode::BAD_REQUEST,
        ServerError::StaleRoot { .. } => StatusCode::CONFLICT,
        ServerError::Replay | ServerError::NullifierUsed => StatusCode::CONFLICT,
        ServerError::LeasePending => StatusCode::CONFLICT,
        ServerError::NoteExpired => StatusCode::GONE,
        ServerError::CapacityExhausted => StatusCode::SERVICE_UNAVAILABLE,
        ServerError::Internal(_) | ServerError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
        ServerError::OaRateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
    };

    let retry_after_seconds = match err {
        ServerError::OaRateLimited {
            retry_after_seconds,
            ..
        } => Some(*retry_after_seconds),
        _ => None,
    };
    let mut headers = HeaderMap::new();
    if let Some(retry_after_seconds) = retry_after_seconds {
        let retry_after = HeaderValue::from_str(&retry_after_seconds.to_string())
            .expect("a decimal u64 is always a valid Retry-After header");
        headers.insert(RETRY_AFTER, retry_after);
    }

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
        retry_after_seconds,
    };

    (status_code, headers, Json(body))
}

fn spawn_openrouter_lease_settler(processor: Arc<RequestProcessor>, interval: Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            processor.settle_due_openrouter_leases().await;
        }
    });
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
        crate::config::ProviderKind::Metered => "metered",
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
mod rate_limit_tests {
    use super::*;

    #[test]
    fn oa_rate_limit_maps_to_retriable_429_with_retry_metadata() {
        let error = ServerError::OaRateLimited {
            reason: "oa_hourly_issuance_budget".to_string(),
            retry_after_seconds: 37,
        };

        let (status, headers, Json(response)) =
            build_error_response(&error, "lease-request-123", None);

        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(headers.get(RETRY_AFTER).unwrap(), "37");
        assert_eq!(response.error_code, "oa_hourly_issuance_budget");
        assert!(response.retriable);
        assert_eq!(response.retry_after_seconds, Some(37));

        let serialized = serde_json::to_value(response).unwrap();
        assert_eq!(serialized["retry_after_seconds"], 37);
        assert_eq!(serialized["error_code"], "oa_hourly_issuance_budget");
    }
}

#[cfg(any())]
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
    async fn test_dashboard_remains_available_without_ephemeral_mode() {
        let app = create_router(test_processor());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let summary = reqwest::get(format!("http://{}/v1/dashboard/summary", addr))
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();

        assert_eq!(summary["server"]["provider"], "echo");
        assert_eq!(summary["totals"]["request_count"], 0);
        assert!(summary["server"].get("ephemeral_enabled").is_none());

        let recent = reqwest::get(format!("http://{}/v1/dashboard/recent", addr))
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(recent, serde_json::json!([]));
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
