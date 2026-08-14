//! HTTP routing layer for `zkapi-clientd`.
//!
//! Wires every endpoint the daemon exposes onto an [`AuthService`]:
//! - upstream-compatible request endpoints (`/v1/chat/completions`,
//!   `/v1/responses`, `/api/chat`) and model listings;
//! - the deposit endpoints (`/deposit/prepare`, `/deposit/confirm`);
//! - local credit management at `/status` (and `/wallet/status`), reporting
//!   whether a note is active, the current balance, expiry timestamp, and a
//!   link to the funding page;
//! - crash recovery (`/wallet/recover`) and the funding-page UI assets and
//!   demo endpoints under `/funding`.
//!
//! Errors are rendered in either a generic or OpenAI-style envelope, with a
//! funding-page hint attached on `402 Payment Required`.

use std::collections::VecDeque;
use std::io;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderName, HeaderValue, Method};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::{self, BoxStream};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::compat;
use crate::error::AuthError;
use crate::service::{AuthService, ConfirmDepositRequest, CoreRequest, WithdrawalMode};

#[derive(Debug, Deserialize)]
struct PrepareDepositBody {
    amount: u128,
}

#[derive(Debug, Deserialize)]
struct WithdrawBody {
    /// "mutual" (server clearance) or "escape" (unilateral escape hatch).
    mode: String,
    /// 20-byte payout address (0x-prefixed or bare hex).
    destination: String,
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
        .route("/wallet/reset", post(wallet_reset))
        .route("/funding/api/reset", post(wallet_reset))
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
        .route("/wallet/withdraw", post(wallet_withdraw))
        .route("/funding/api/withdraw", post(wallet_withdraw))
        // Browser client endpoints: full zkAPI inspection per call.
        .route("/zkapi/v1/config", get(zkapi_config))
        .route("/zkapi/v1/inference", post(zkapi_inference))
        .layer(local_cors_layer())
        .with_state(service)
}

/// A deliberately narrow CORS policy.
///
/// The funding UI is served by this same daemon, so it is same-origin and does
/// not depend on CORS at all. Cross-origin access is restricted to loopback
/// origins (any port) for local browser tooling, and credentials are never
/// enabled — so this is never the unsafe wildcard-origin-with-credentials
/// combination.
fn local_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE])
        .allow_origin(AllowOrigin::predicate(|origin, _request| {
            let origin = origin.as_bytes();
            origin.starts_with(b"http://localhost") || origin.starts_with(b"http://127.0.0.1")
        }))
}

pub async fn run(service: Arc<AuthService>, listen_addr: &str) -> anyhow::Result<()> {
    let reconciler = service.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            reconciler.reconcile_direct_openrouter().await;
        }
    });
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
    if compat::stream_requested(&body) {
        return match service
            .execute_streaming_request(compat::core_request("/v1/chat/completions", body))
            .await
        {
            Ok(upstream) => streaming_openrouter_response(upstream),
            Err(err) => openai_error(err),
        };
    }
    let model = compat::extract_model(&body, service.default_model());
    match service
        .execute_request(compat::core_request("/v1/chat/completions", body))
        .await
    {
        Ok(response) => Json(compat::chat_completion(&model, &response)).into_response(),
        Err(err) => openai_error(err),
    }
}

fn streaming_openrouter_response(upstream: reqwest::Response) -> Response {
    let status = upstream.status();
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let cache_control = upstream.headers().get(header::CACHE_CONTROL).cloned();
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        content_type.unwrap_or_else(|| HeaderValue::from_static("text/event-stream")),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        cache_control.unwrap_or_else(|| HeaderValue::from_static("no-cache")),
    );
    response.headers_mut().insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    response
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
    if compat::ollama_stream_requested(&body) {
        let mut body = body;
        if let Some(object) = body.as_object_mut() {
            // Ollama defaults to streaming. Make that default explicit before
            // normalizing the request into OpenRouter's chat format.
            object.insert("stream".to_string(), Value::Bool(true));
        }
        return match service
            .execute_streaming_request(compat::core_request("/api/chat", body))
            .await
        {
            Ok(upstream) => streaming_ollama_response(upstream, model),
            Err(err) => generic_error(err),
        };
    }
    match service
        .execute_request(compat::core_request("/api/chat", body))
        .await
    {
        Ok(response) => Json(compat::ollama_chat(&model, &response)).into_response(),
        Err(err) => generic_error(err),
    }
}

struct OllamaStreamState {
    upstream: BoxStream<'static, Result<Bytes, reqwest::Error>>,
    model: String,
    input: Vec<u8>,
    output: VecDeque<Result<Bytes, io::Error>>,
    prompt_tokens: u64,
    completion_tokens: u64,
    finish_reason: String,
    finished: bool,
}

impl OllamaStreamState {
    fn consume_complete_lines(&mut self) {
        while !self.finished {
            let Some(newline) = self.input.iter().position(|byte| *byte == b'\n') else {
                break;
            };
            let mut line = self.input.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.consume_sse_line(&line);
        }
    }

    fn consume_sse_line(&mut self, line: &[u8]) {
        let Some(payload) = line.strip_prefix(b"data:") else {
            // OpenRouter emits `: OPENROUTER PROCESSING` SSE comments while a
            // provider is starting. They are valid SSE but not Ollama JSON.
            return;
        };
        let payload = payload.strip_prefix(b" ").unwrap_or(payload);
        if payload.is_empty() {
            return;
        }
        if payload == b"[DONE]" {
            self.enqueue_done();
            return;
        }
        let chunk: Value = match serde_json::from_slice(payload) {
            Ok(chunk) => chunk,
            Err(error) => {
                self.output.push_back(Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid OpenRouter SSE event: {error}"),
                )));
                self.finished = true;
                return;
            }
        };

        if let Some(usage) = chunk.get("usage") {
            self.prompt_tokens = usage
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(self.prompt_tokens);
            self.completion_tokens = usage
                .get("completion_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(self.completion_tokens);
        }
        if let Some(error) = chunk.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("OpenRouter streaming error");
            self.enqueue_json(json!({ "error": message }));
            self.finished = true;
            return;
        }

        let choice = chunk.get("choices").and_then(|choices| choices.get(0));
        if let Some(reason) = choice
            .and_then(|choice| choice.get("finish_reason"))
            .and_then(Value::as_str)
        {
            self.finish_reason = reason.to_string();
        }
        let delta = choice.and_then(|choice| choice.get("delta"));
        let content = delta
            .and_then(|delta| delta.get("content"))
            .and_then(Value::as_str)
            .filter(|content| !content.is_empty());
        let thinking = delta
            .and_then(|delta| {
                delta
                    .get("reasoning_content")
                    .or_else(|| delta.get("reasoning"))
            })
            .and_then(Value::as_str)
            .filter(|thinking| !thinking.is_empty());
        let tool_calls = delta
            .and_then(|delta| delta.get("tool_calls"))
            .filter(|tool_calls| !tool_calls.is_null());
        if content.is_none() && thinking.is_none() && tool_calls.is_none() {
            return;
        }

        let mut message = serde_json::Map::from_iter([
            ("role".to_string(), Value::String("assistant".to_string())),
            (
                "content".to_string(),
                Value::String(content.unwrap_or_default().to_string()),
            ),
        ]);
        if let Some(thinking) = thinking {
            message.insert("thinking".to_string(), Value::String(thinking.to_string()));
        }
        if let Some(tool_calls) = tool_calls {
            message.insert("tool_calls".to_string(), tool_calls.clone());
        }
        self.enqueue_json(json!({
            "model": self.model,
            "created_at": "1970-01-01T00:00:00Z",
            "message": message,
            "done": false,
        }));
    }

    fn enqueue_done(&mut self) {
        if self.finished {
            return;
        }
        self.enqueue_json(json!({
            "model": self.model,
            "created_at": "1970-01-01T00:00:00Z",
            "message": { "role": "assistant", "content": "" },
            "done": true,
            "done_reason": self.finish_reason,
            "total_duration": 0,
            "load_duration": 0,
            "prompt_eval_count": self.prompt_tokens,
            "eval_count": self.completion_tokens,
        }));
        self.finished = true;
    }

    fn enqueue_json(&mut self, value: Value) {
        let mut line = serde_json::to_vec(&value).expect("serializing an Ollama stream chunk");
        line.push(b'\n');
        self.output.push_back(Ok(Bytes::from(line)));
    }
}

fn streaming_ollama_response(upstream: reqwest::Response, model: String) -> Response {
    let status = upstream.status();
    let state = OllamaStreamState {
        upstream: upstream.bytes_stream().boxed(),
        model,
        input: Vec::new(),
        output: VecDeque::new(),
        prompt_tokens: 0,
        completion_tokens: 0,
        finish_reason: "stop".to_string(),
        finished: false,
    };
    let output = stream::unfold(state, |mut state| async move {
        loop {
            if let Some(chunk) = state.output.pop_front() {
                return Some((chunk, state));
            }
            if state.finished {
                return None;
            }
            match state.upstream.next().await {
                Some(Ok(chunk)) => {
                    state.input.extend_from_slice(&chunk);
                    state.consume_complete_lines();
                }
                Some(Err(error)) => {
                    state.finished = true;
                    return Some((Err(io::Error::other(error)), state));
                }
                None => {
                    if !state.input.is_empty() {
                        let line = std::mem::take(&mut state.input);
                        state.consume_sse_line(&line);
                    }
                    state.enqueue_done();
                }
            }
        }
    });

    let mut response = Response::new(Body::from_stream(output));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-transform"),
    );
    response.headers_mut().insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    response
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

async fn wallet_reset(State(service): State<Arc<AuthService>>) -> Response {
    match service.reset_wallet().await {
        Ok(status) => Json(status).into_response(),
        Err(err) => generic_error(err),
    }
}

async fn wallet_withdraw(
    State(service): State<Arc<AuthService>>,
    Json(body): Json<WithdrawBody>,
) -> Response {
    let mode = match body.mode.trim().to_ascii_lowercase().as_str() {
        "mutual" | "mutual-close" | "mutualclose" => WithdrawalMode::Mutual,
        "escape" | "escape-hatch" | "escapehatch" => WithdrawalMode::Escape,
        other => {
            return generic_error(AuthError::InvalidInput(format!(
                "unknown withdrawal mode '{other}' (expected 'mutual' or 'escape')"
            )))
        }
    };
    let destination = match parse_destination(&body.destination) {
        Ok(dest) => dest,
        Err(msg) => return generic_error(AuthError::InvalidInput(msg)),
    };
    match service.create_withdrawal(mode, destination).await {
        Ok(plan) => Json(plan).into_response(),
        Err(err) => generic_error(err),
    }
}

fn parse_destination(value: &str) -> Result<[u8; 20], String> {
    let hex = value.strip_prefix("0x").unwrap_or(value);
    if hex.len() != 40 {
        return Err("destination must be a 20-byte hex address".to_string());
    }
    let mut bytes = [0u8; 20];
    for (idx, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let part = std::str::from_utf8(chunk).map_err(|e| e.to_string())?;
        bytes[idx] = u8::from_str_radix(part, 16).map_err(|e| e.to_string())?;
    }
    Ok(bytes)
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

/// GET /zkapi/v1/config -- integration config for the client (credit scale,
/// caps, upstream metadata, and funding parameters).
async fn zkapi_config(State(service): State<Arc<AuthService>>) -> Response {
    Json(service.zkapi_config().await).into_response()
}

/// POST /zkapi/v1/inference -- run an OpenAI-style chat
/// completion through the full zkAPI proof+billing path and return both the
/// completion and the complete zkAPI inspection (`RequestDemoResult`).
async fn zkapi_inference(
    State(service): State<Arc<AuthService>>,
    Json(body): Json<Value>,
) -> Response {
    let request = CoreRequest::post_json("/v1/chat/completions", body);
    match service.execute_request_demo(request).await {
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
    let funding_url = err.funding_url();
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
    let funding_url = err.funding_url();
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
    use axum::http::StatusCode;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::config::{AuthConfig, ModelDescriptor};

    #[tokio::test]
    async fn openai_errors_preserve_upstream_status_without_wallet_funding_hint() {
        let response = openai_error(AuthError::UpstreamResponse {
            status: StatusCode::PAYMENT_REQUIRED,
            message: "lease credit exhausted".to_string(),
        });
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["error"]["code"], "upstream_error");
        assert_eq!(value["error"]["funding_url"], Value::Null);
    }

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

        for path in ["/zkapi/v1/ephemeral/issue", "/zkapi/v1/ephemeral/settle"] {
            let removed = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(removed.status(), StatusCode::NOT_FOUND);
        }

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
        assert_eq!(value["runtime_proof_backend"], "groth16_bn254");
        assert_eq!(value["funding"]["models"][0]["id"], "demo-model");
    }
}
