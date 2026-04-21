use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::compat;
use crate::error::AuthError;
use crate::service::{AuthService, ConfirmDepositRequest, CoreRequest};

#[derive(Debug, Deserialize)]
struct PrepareDepositBody {
    amount: u128,
}

pub fn build_router(service: Arc<AuthService>) -> Router {
    Router::new()
        .route("/", get(funding_index))
        .route("/health", get(healthz))
        .route("/healthz", get(healthz))
        .route("/request", post(core_request))
        .route("/status", get(wallet_status))
        .route("/deposit/prepare", post(prepare_deposit))
        .route("/deposit/confirm", post(confirm_deposit))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/responses", post(responses_api))
        .route("/api/chat", post(ollama_chat))
        .route("/v1/models", get(models))
        .route("/api/tags", get(tags))
        .route("/funding/config", get(funding_config))
        .route("/wallet/status", get(wallet_status))
        .route("/wallet/recover", post(wallet_recover))
        .route("/funding", get(funding_index))
        .route("/funding/", get(funding_index))
        .route("/funding/styles.css", get(funding_styles))
        .route("/funding/app.js", get(funding_app))
        .route("/funding/api/status", get(wallet_status))
        .route("/funding/api/demo", get(demo_overview))
        .route("/funding/api/deposit/prepare", post(prepare_deposit))
        .route("/funding/api/deposit/confirm", post(confirm_deposit))
        .route("/funding/api/request/preview", post(request_preview))
        .route("/funding/api/request/submit", post(request_submit))
        .route("/funding/api/recover", post(wallet_recover))
        .with_state(service)
}

pub async fn run(service: Arc<AuthService>, listen_addr: &str) -> anyhow::Result<()> {
    let router = build_router(service);
    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    tracing::info!("zkapi-clientd listening on {}", listen_addr);
    axum::serve(listener, router).await?;
    Ok(())
}

async fn healthz() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn core_request(
    State(service): State<Arc<AuthService>>,
    Json(request): Json<CoreRequest>,
) -> Response {
    match service.execute_request(request).await {
        Ok(response) => Json(response).into_response(),
        Err(err) => generic_error(err),
    }
}

async fn chat_completions(
    State(service): State<Arc<AuthService>>,
    Json(body): Json<Value>,
) -> Response {
    let model = compat::extract_model(&body, service.default_model());
    match service
        .execute_request(compat::core_request("/v1/chat/completions", body))
        .await
    {
        Ok(response) => Json(compat::chat_completion(&model, &response)).into_response(),
        Err(err) => openai_error(err),
    }
}

async fn responses_api(
    State(service): State<Arc<AuthService>>,
    Json(body): Json<Value>,
) -> Response {
    let model = compat::extract_model(&body, service.default_model());
    match service
        .execute_request(compat::core_request("/v1/responses", body))
        .await
    {
        Ok(response) => Json(compat::responses_api(&model, &response)).into_response(),
        Err(err) => openai_error(err),
    }
}

async fn ollama_chat(State(service): State<Arc<AuthService>>, Json(body): Json<Value>) -> Response {
    let model = compat::extract_model(&body, service.default_model());
    match service
        .execute_request(compat::core_request("/api/chat", body))
        .await
    {
        Ok(response) => Json(compat::ollama_chat(&model, &response)).into_response(),
        Err(err) => generic_error(err),
    }
}

async fn models(State(service): State<Arc<AuthService>>) -> Json<Value> {
    Json(compat::openai_models(service.models()))
}

async fn tags(State(service): State<Arc<AuthService>>) -> Json<Value> {
    Json(compat::ollama_tags(service.models()))
}

async fn wallet_status(State(service): State<Arc<AuthService>>) -> Response {
    match service.status().await {
        Ok(status) => Json(status).into_response(),
        Err(err) => generic_error(err),
    }
}

async fn wallet_recover(State(service): State<Arc<AuthService>>) -> Response {
    match service.recover().await {
        Ok(status) => Json(status).into_response(),
        Err(err) => generic_error(err),
    }
}

async fn demo_overview(State(service): State<Arc<AuthService>>) -> Response {
    match service.demo_overview().await {
        Ok(overview) => Json(overview).into_response(),
        Err(err) => generic_error(err),
    }
}

async fn funding_config(State(service): State<Arc<AuthService>>) -> Json<Value> {
    Json(json!(service.funding_config()))
}

async fn funding_index(State(service): State<Arc<AuthService>>) -> Response {
    Html(service.funding_index_html()).into_response()
}

async fn funding_styles(State(service): State<Arc<AuthService>>) -> Response {
    static_asset(service.funding_styles_css(), "text/css; charset=utf-8")
}

async fn funding_app(State(service): State<Arc<AuthService>>) -> Response {
    static_asset(
        service.funding_app_js(),
        "application/javascript; charset=utf-8",
    )
}

async fn prepare_deposit(
    State(service): State<Arc<AuthService>>,
    Json(body): Json<PrepareDepositBody>,
) -> Response {
    match service.prepare_deposit(body.amount).await {
        Ok(plan) => Json(plan).into_response(),
        Err(err) => generic_error(err),
    }
}

async fn confirm_deposit(
    State(service): State<Arc<AuthService>>,
    Json(body): Json<ConfirmDepositRequest>,
) -> Response {
    match service.confirm_deposit(body).await {
        Ok(status) => Json(status).into_response(),
        Err(err) => generic_error(err),
    }
}

async fn request_preview(
    State(service): State<Arc<AuthService>>,
    Json(body): Json<CoreRequest>,
) -> Response {
    match service.preview_request(body).await {
        Ok(preview) => Json(preview).into_response(),
        Err(err) => generic_error(err),
    }
}

async fn request_submit(
    State(service): State<Arc<AuthService>>,
    Json(body): Json<CoreRequest>,
) -> Response {
    match service.execute_request_demo(body).await {
        Ok(result) => Json(result).into_response(),
        Err(err) => generic_error(err),
    }
}

fn static_asset(body: &'static str, content_type: &'static str) -> Response {
    let mut response = body.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
}

fn generic_error(err: AuthError) -> Response {
    let status = err.status_code();
    let funding_url = if status == StatusCode::PAYMENT_REQUIRED {
        Some("/funding")
    } else {
        None
    };
    (
        status,
        Json(json!({
            "error": {
                "code": err.code(),
                "message": err.to_string(),
                "funding_url": funding_url,
            }
        })),
    )
        .into_response()
}

fn openai_error(err: AuthError) -> Response {
    let status = err.status_code();
    let funding_url = if status == StatusCode::PAYMENT_REQUIRED {
        Some("/funding")
    } else {
        None
    };
    (
        status,
        Json(json!({
            "error": {
                "message": err.to_string(),
                "type": err.code(),
                "param": Value::Null,
                "code": err.code(),
                "funding_url": funding_url,
            }
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::config::{AuthConfig, ModelDescriptor};

    #[tokio::test]
    async fn serves_funding_page_assets_and_model_lists() {
        let state_dir = std::env::temp_dir().join("zkapi_clientd_routes_assets");
        let service = AuthService::new(AuthConfig {
            state_dir,
            models: vec![ModelDescriptor::new("demo-model")],
            demo_rpc_url: Some("http://127.0.0.1:48654".to_string()),
            demo_billing_token_address: Some("0xabc".to_string()),
            demo_private_key: Some("0xpriv".to_string()),
            demo_note_ttl_seconds: Some(1234),
            ..Default::default()
        })
        .unwrap();
        let router = build_router(service);

        let funding = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/funding")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(funding.status(), StatusCode::OK);

        let models = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/v1/models")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = models.into_body().collect().await.unwrap().to_bytes();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["data"][0]["id"], "demo-model");

        let health = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let config = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/funding/config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = config.into_body().collect().await.unwrap().to_bytes();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["models"][0]["id"], "demo-model");
        assert_eq!(value["chain_id"], 1);
        assert_eq!(value["demo_rpc_url"], "http://127.0.0.1:48654");
        assert_eq!(value["demo_billing_token_address"], "0xabc");
        assert_eq!(value["demo_private_key"], "0xpriv");
        assert_eq!(value["demo_note_ttl_seconds"], 1234);

        let demo = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/funding/api/demo")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(demo.status(), StatusCode::OK);
        let body = demo.into_body().collect().await.unwrap().to_bytes();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["runtime_proof_backend"], "mock_envelope");
        assert_eq!(value["funding"]["models"][0]["id"], "demo-model");
    }
}
