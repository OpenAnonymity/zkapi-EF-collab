use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header::AUTHORIZATION, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use zkapi_client::config::{ClientConfig, ClientProofMode};
use zkapi_client::wallet::Wallet;
use zkapi_clientd::{AuthConfig, AuthService, CoreRequest, ModelDescriptor, RequestMode};
use zkapi_core::merkle::MerkleTree;
use zkapi_core::v2 as core;
use zkapi_serverd::config::{
    OpenRouterLeaseConfig, OpenRouterLeaseSourceConfig, ProviderKind, ServerConfig,
};
use zkapi_serverd::nullifier_store::NullifierStore;
use zkapi_serverd::processor::RequestProcessor;
use zkapi_serverd::provider::EchoProvider;
use zkapi_serverd::routes::create_router;
use zkapi_serverd::signer::ServerSigner;
use zkapi_types::Felt252;

#[derive(Clone)]
struct IndexerState {
    tree: Arc<RwLock<MerkleTree>>,
}

#[derive(Clone, Default)]
struct OpenRouterState {
    prompts: Arc<Mutex<Vec<String>>>,
    create_bodies: Arc<Mutex<Vec<Value>>>,
    deletes: Arc<Mutex<usize>>,
    inference_attempts: Arc<Mutex<usize>>,
    inference_failures_remaining: Arc<Mutex<usize>>,
    key_usage: Arc<Mutex<HashMap<String, usize>>>,
    in_flight: Arc<AtomicUsize>,
    max_in_flight: Arc<AtomicUsize>,
}

#[derive(Clone, Default)]
struct OaFlowState {
    events: Arc<Mutex<Vec<String>>>,
    org_requests: Arc<Mutex<Vec<Value>>>,
    verifier_requests: Arc<Mutex<Vec<Value>>>,
    prompts: Arc<Mutex<Vec<String>>>,
    verifier_rejections_remaining: Arc<Mutex<usize>>,
    verifier_attempts: Arc<Mutex<usize>>,
    inference_auth_failures_remaining: Arc<Mutex<usize>>,
    leases: Arc<Mutex<HashMap<String, (String, u64)>>>,
    usage_polls: Arc<Mutex<HashMap<String, usize>>>,
}

async fn spawn(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{address}")
}

fn indexer_router(tree: Arc<RwLock<MerkleTree>>) -> Router {
    async fn root(State(state): State<IndexerState>) -> Json<Value> {
        Json(json!({ "root": state.tree.read().unwrap().root() }))
    }
    async fn path(State(state): State<IndexerState>, Path(note_id): Path<u32>) -> Json<Value> {
        let tree = state.tree.read().unwrap();
        Json(json!({
            "note_id": note_id,
            "leaf": tree.get_leaf(note_id),
            "siblings": tree.get_siblings(note_id),
        }))
    }
    async fn next_note_id(State(state): State<IndexerState>) -> Json<Value> {
        Json(json!({ "next_note_id": state.tree.read().unwrap().next_index() }))
    }
    Router::new()
        .route("/v1/tree/root", get(root))
        .route("/v1/tree/next-note-id", get(next_note_id))
        .route("/v1/tree/notes/{note_id}/path", get(path))
        .route("/v1/tree/notes/{note_id}/zero-path", get(path))
        .with_state(IndexerState { tree })
}

fn openrouter_router(state: OpenRouterState) -> Router {
    async fn create_key(
        State(state): State<OpenRouterState>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, StatusCode> {
        if headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            != Some("Bearer management-test-key")
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        state.create_bodies.lock().unwrap().push(body.clone());
        let issuance = state.create_bodies.lock().unwrap().len();
        let canonical_expiry = format!(
            "{}.000Z",
            body["expires_at"]
                .as_str()
                .unwrap_or_default()
                .trim_end_matches('Z')
        );
        Ok(Json(json!({
            "key": format!("sk-or-v1-runtime-test-{issuance}"),
            "data": {
                "hash": format!("runtime-hash-{issuance}"),
                "usage": 0.0,
                "limit": body["limit"],
                "expires_at": canonical_expiry,
                "include_byok_in_limit": body["include_byok_in_limit"]
            }
        })))
    }
    async fn infer(
        State(state): State<OpenRouterState>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Result<Response, (StatusCode, Json<Value>)> {
        let api_key = headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::to_owned);
        if !api_key
            .as_deref()
            .is_some_and(|key| key.starts_with("sk-or-v1-runtime-test-"))
        {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": { "message": "invalid key" } })),
            ));
        }
        *state.inference_attempts.lock().unwrap() += 1;
        {
            let mut failures = state.inference_failures_remaining.lock().unwrap();
            if *failures > 0 {
                *failures -= 1;
                return Err((
                    StatusCode::BAD_GATEWAY,
                    Json(json!({
                        "error": {
                            "code": 502,
                            "message": "provider temporarily unavailable",
                            "metadata": { "error_type": "provider_unavailable" }
                        }
                    })),
                ));
            }
        }
        let api_key = api_key.unwrap();
        let prompt = body["messages"][0]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let active = state.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        state.max_in_flight.fetch_max(active, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(120)).await;
        state.prompts.lock().unwrap().push(prompt.clone());
        *state.key_usage.lock().unwrap().entry(api_key).or_default() += 1;
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            let chunks = VecDeque::from([
                Bytes::from_static(
                    b"data: {\"choices\":[{\"delta\":{\"content\":\"answer: \"}}]}\n\n",
                ),
                Bytes::from(format!(
                    "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n\n",
                    serde_json::to_string(&prompt).unwrap()
                )),
                Bytes::from_static(b"data: [DONE]\n\n"),
            ]);
            let chunks = stream::unfold((chunks, 0usize), |(mut chunks, index)| async move {
                let chunk = chunks.pop_front()?;
                if index > 0 {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
                Some((Ok::<Bytes, Infallible>(chunk), (chunks, index + 1)))
            });
            let mut response = Response::new(Body::from_stream(chunks));
            response.headers_mut().insert(
                axum::http::header::CONTENT_TYPE,
                HeaderValue::from_static("text/event-stream"),
            );
            state.in_flight.fetch_sub(1, Ordering::SeqCst);
            return Ok(response);
        }
        state.in_flight.fetch_sub(1, Ordering::SeqCst);
        Ok(Json(json!({
            "id": "chatcmpl-direct",
            "object": "chat.completion",
            "model": body["model"],
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": format!("answer: {prompt}") },
                "finish_reason": "stop"
            }],
            "usage": { "prompt_tokens": 2, "completion_tokens": 2, "total_tokens": 4 }
        }))
        .into_response())
    }
    async fn get_key(
        State(state): State<OpenRouterState>,
        Path(hash): Path<String>,
        headers: HeaderMap,
    ) -> Result<Json<Value>, StatusCode> {
        if !hash.starts_with("runtime-hash-")
            || headers
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                != Some("Bearer management-test-key")
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let key = hash.replacen("runtime-hash-", "sk-or-v1-runtime-test-", 1);
        let calls = *state.key_usage.lock().unwrap().get(&key).unwrap_or(&0);
        Ok(Json(json!({
            "data": { "hash": hash, "usage": 0.000006 * calls as f64, "limit": 0.001 }
        })))
    }
    async fn delete_key(
        State(state): State<OpenRouterState>,
        Path(hash): Path<String>,
        headers: HeaderMap,
    ) -> StatusCode {
        if !hash.starts_with("runtime-hash-")
            || headers
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                != Some("Bearer management-test-key")
        {
            return StatusCode::UNAUTHORIZED;
        }
        *state.deletes.lock().unwrap() += 1;
        StatusCode::NO_CONTENT
    }
    Router::new()
        .route("/api/v1/keys", post(create_key))
        .route("/api/v1/keys/{hash}", get(get_key).delete(delete_key))
        .route("/api/v1/chat/completions", post(infer))
        .with_state(state)
}

fn oa_verifier_router(state: OaFlowState) -> Router {
    async fn submit_key(
        State(state): State<OaFlowState>,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
        if body["station_id"] != "station-test"
            || !body["api_key"]
                .as_str()
                .is_some_and(|key| key.starts_with("sk-or-v1-oa-test-"))
            || body["station_signature"].as_str().map(str::len) != Some(128)
            || body["org_signature"].as_str().map(str::len) != Some(128)
        {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "detail": "invalid evidence" })),
            ));
        }
        *state.verifier_attempts.lock().unwrap() += 1;
        let mut failures = state.verifier_rejections_remaining.lock().unwrap();
        if *failures > 0 {
            *failures -= 1;
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "status": "unverified",
                    "detail": "ownership_check_error",
                    "retryable": true
                })),
            ));
        }
        drop(failures);
        state.events.lock().unwrap().push("verified".to_string());
        state.verifier_requests.lock().unwrap().push(body);
        Ok(Json(json!({ "status": "verified" })))
    }
    Router::new()
        .route("/submit_key", post(submit_key))
        .with_state(state)
}

fn oa_inference_router(state: OaFlowState) -> Router {
    async fn infer(
        State(state): State<OaFlowState>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, StatusCode> {
        let api_key = headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        if !api_key.is_some_and(|key| key.starts_with("sk-or-v1-oa-test-")) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let mut failures = state.inference_auth_failures_remaining.lock().unwrap();
        if *failures > 0 {
            *failures -= 1;
            state
                .events
                .lock()
                .unwrap()
                .push("inference_rejected".to_string());
            return Err(StatusCode::UNAUTHORIZED);
        }
        drop(failures);
        let prompt = body["messages"][0]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        state.events.lock().unwrap().push("inference".to_string());
        state.prompts.lock().unwrap().push(prompt.clone());
        Ok(Json(json!({
            "id": "chatcmpl-oa",
            "object": "chat.completion",
            "model": body["model"],
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": format!("verified: {prompt}") },
                "finish_reason": "stop"
            }]
        })))
    }
    Router::new()
        .route("/v1/chat/completions", post(infer))
        .with_state(state)
}

fn oa_org_router(state: OaFlowState, verifier_url: String, inference_url: String) -> Router {
    #[derive(Clone)]
    struct OaOrgState {
        flow: OaFlowState,
        verifier_url: String,
        inference_url: String,
    }

    async fn request_key(
        State(state): State<OaOrgState>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, StatusCode> {
        if headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            != Some("Bearer oa-org-test-secret")
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        if body["credit_limit"] != 0.001 || body["duration_minutes"] != 1 {
            return Err(StatusCode::BAD_REQUEST);
        }
        state.flow.events.lock().unwrap().push("issued".to_string());
        state.flow.org_requests.lock().unwrap().push(body.clone());
        let issuance = state.flow.org_requests.lock().unwrap().len();
        let expires_at = now_seconds() + 60;
        let key_hash = format!("oa-runtime-hash-{issuance}");
        state.flow.leases.lock().unwrap().insert(
            key_hash.clone(),
            (
                body["client_request_id"].as_str().unwrap().to_string(),
                expires_at,
            ),
        );
        Ok(Json(json!({
            "source": "oa_org",
            "key": format!("sk-or-v1-oa-test-{issuance}"),
            "key_hash": key_hash,
            "credit_limit": 0.001,
            "duration_minutes": 1,
            "expires_at": "future",
            "expires_at_unix": expires_at,
            "station_id": "station-test",
            "station_url": "https://station.example",
            "station_recently_attested": true,
            "station_signature": "ab".repeat(64),
            "org_signature": "cd".repeat(64),
            "verifier_url": state.verifier_url,
            "openrouter_api_base": format!("{}/v1", state.inference_url),
        })))
    }

    async fn key_usage(
        State(state): State<OaOrgState>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, StatusCode> {
        if headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            != Some("Bearer oa-org-test-secret")
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let key_hash = body["key_hash"].as_str().ok_or(StatusCode::BAD_REQUEST)?;
        let (client_request_id, expires_at) = state
            .flow
            .leases
            .lock()
            .unwrap()
            .get(key_hash)
            .cloned()
            .ok_or(StatusCode::NOT_FOUND)?;
        if body["client_request_id"] != client_request_id {
            return Err(StatusCode::CONFLICT);
        }
        let poll = {
            let mut polls = state.flow.usage_polls.lock().unwrap();
            let poll = polls.entry(key_hash.to_string()).or_default();
            *poll += 1;
            *poll
        };
        if poll == 1 {
            return Ok(Json(json!({
                "source": "oa_org",
                "version": 1,
                "status": "pending",
                "client_request_id": client_request_id,
                "station_request_id": "ef".repeat(32),
                "key_hash": key_hash,
                "retry_after_seconds": 1,
            })));
        }
        let closed_at = now_seconds().min(expires_at);
        Ok(Json(json!({
            "source": "oa_org",
            "version": 1,
            "status": "finalized",
            "client_request_id": client_request_id,
            "station_request_id": "ef".repeat(32),
            "key_hash": key_hash,
            "usage_credits": 7,
            "credit_limit_credits": 1000,
            "expires_at_unix": expires_at,
            "closed_at_unix": closed_at,
            "finalized_at_unix": closed_at,
            "station_id": "station-test",
            "station_signature": "ab".repeat(64),
            "org_signature": "cd".repeat(64),
        })))
    }

    Router::new()
        .route("/api/zkapi/request_key", post(request_key))
        .route("/api/zkapi/key_usage", post(key_usage))
        .with_state(OaOrgState {
            flow: state,
            verifier_url,
            inference_url,
        })
}

fn test_directory() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("zkapi-direct-openrouter-{nonce}"));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn setup_directory() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/setup/v2")
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_lease_is_reused_for_the_chat_until_explicit_settlement() {
    let directory = test_directory();
    let wallet_directory = directory.join("wallet");
    let contract = Felt252::from_u64(0xdeadbeef);
    let deposit = 10_000u128;
    let request_cap = 1_000u128;
    let expiry = 4_000_000_000u64;
    let setup_directory = setup_directory();

    let state_seed = Felt252::from_u64(11);
    let clear_seed = Felt252::from_u64(12);
    let signer = Arc::new(ServerSigner::new(&state_seed, &clear_seed));
    let state_key = signer.state_public_key();
    let clearance_key = signer.clearance_public_key();

    let mut seed_wallet = Wallet::new(ClientConfig {
        protocol_version: 2,
        chain_id: 1,
        contract_address: contract,
        request_charge_cap: request_cap,
        policy_charge_cap: request_cap,
        policy_enabled: false,
        server_url: "http://127.0.0.1:1".to_string(),
        state_dir: wallet_directory.to_string_lossy().to_string(),
        trusted_epoch_roots: Vec::new(),
        proof_mode: ClientProofMode::Groth16 {
            setup_dir: setup_directory.clone(),
        },
        state_signing_key: state_key.clone(),
        clearance_signing_key: clearance_key.clone(),
    })
    .unwrap();
    let (secret, registration) = seed_wallet.generate_deposit_params();
    seed_wallet
        .confirm_deposit(secret, 0, deposit, expiry)
        .unwrap();

    let mut tree = MerkleTree::new();
    tree.insert(core::note_leaf(0, &registration, deposit, expiry));
    let tree = Arc::new(RwLock::new(tree));
    let root = tree.read().unwrap().root();
    let indexer_url = spawn(indexer_router(tree.clone())).await;

    let openrouter_state = OpenRouterState::default();
    let live_management_key = std::env::var("ZKAPI_LIVE_OPENROUTER_MANAGEMENT_KEY")
        .ok()
        .filter(|key| !key.is_empty());
    let live_openrouter = live_management_key.is_some();
    let openrouter_url = if live_openrouter {
        "https://openrouter.ai".to_string()
    } else {
        spawn(openrouter_router(openrouter_state.clone())).await
    };
    let store = Arc::new(NullifierStore::new(directory.join("server.db")).unwrap());
    let processor = Arc::new(
        RequestProcessor::try_new(
            ServerConfig {
                protocol_version: 2,
                chain_id: 1,
                contract_address: contract,
                request_charge_cap: request_cap,
                policy_charge_cap: request_cap,
                policy_enabled: false,
                provider_kind: ProviderKind::Echo,
                echo_fixed_charge: 1,
                db_path: directory.join("server.db").to_string_lossy().to_string(),
                state_seed,
                clear_seed,
                initial_root: root,
                proof_setup_dir: setup_directory.clone(),
                openrouter_leases: Some(OpenRouterLeaseConfig {
                    source: OpenRouterLeaseSourceConfig::OpenRouter {
                        management_key: live_management_key
                            .unwrap_or_else(|| "management-test-key".to_string()),
                        api_base: format!("{openrouter_url}/api"),
                    },
                    // Keep the mock lease alive long enough to prove that all
                    // chat, title/response, SSE, and Ollama calls reuse it.
                    ttl_seconds: if live_openrouter { 30 } else { 120 },
                    settlement_grace_seconds: if live_openrouter { 20 } else { 0 },
                    settlement_poll_seconds: 1,
                }),
                ..Default::default()
            },
            store.clone(),
            signer,
            Arc::new(EchoProvider::new(1)),
            root,
        )
        .unwrap(),
    );
    let protocol_server_url = spawn(create_router(processor.clone())).await;
    let service = AuthService::new(AuthConfig {
        protocol_version: 2,
        chain_id: 1,
        contract_address: contract,
        request_charge_cap: request_cap,
        policy_charge_cap: request_cap,
        policy_enabled: false,
        protocol_server_url: protocol_server_url.clone(),
        indexer_url,
        state_dir: wallet_directory.clone(),
        models: vec![ModelDescriptor::new("openai/gpt-4o-mini")],
        proof_setup_dir: setup_directory.clone(),
        state_signing_key: state_key.clone(),
        clearance_signing_key: clearance_key.clone(),
        request_mode: RequestMode::DirectOpenrouter,
        openrouter_inference_base: format!("{openrouter_url}/api/v1"),
        ..Default::default()
    })
    .unwrap();
    service.ensure_request_mode_available().await.unwrap();
    let health: Value = reqwest::get(format!("{protocol_server_url}/health"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        health["request_modes"],
        json!(["proxy", "direct_openrouter"])
    );

    let first_request = CoreRequest::post_json(
        "/v1/chat/completions",
        json!({
            "model": "openai/gpt-4o-mini",
            "messages": [{"role": "user", "content": "private prompt one"}]
        }),
    );
    let second_request = CoreRequest::post_json(
        "/v1/responses",
        json!({
            "model": "openai/gpt-4o-mini",
            "input": "private prompt two"
        }),
    );
    let (first, second) = if live_openrouter {
        let first = service.execute_request(first_request).await.unwrap();
        let second = service.execute_request(second_request).await.unwrap();
        (first, second)
    } else {
        // Reproduce OpenRouter's intermittent provider_unavailable response.
        // The client should absorb the 502 and retry the exact inference on
        // the still-valid lease key.
        *openrouter_state
            .inference_failures_remaining
            .lock()
            .unwrap() = 1;
        let first_service = service.clone();
        let first_task = tokio::spawn(async move {
            first_service
                .execute_request_in_session(first_request, Some("chat-one"))
                .await
        });
        tokio::time::timeout(Duration::from_secs(60), async {
            while openrouter_state.in_flight.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first same-session request should reach inference");

        let active_lease = service.zkapi_config().await.active_lease.unwrap();
        assert_eq!(active_lease.session_id, "chat-one");
        assert!(!serde_json::to_string(&active_lease)
            .unwrap()
            .contains("sk-or-v1-"));

        let cross_chat = service
            .execute_request_in_session(
                CoreRequest::post_json(
                    "/v1/chat/completions",
                    json!({
                        "model": "openai/gpt-4o-mini",
                        "messages": [{"role": "user", "content": "must not share a key"}]
                    }),
                ),
                Some("chat-two"),
            )
            .await
            .unwrap_err();
        assert_eq!(cross_chat.status_code(), StatusCode::CONFLICT);
        assert_eq!(cross_chat.code(), "lease_session_conflict");

        let second = service
            .execute_request_in_session(second_request, Some("chat-one"))
            .await
            .unwrap();
        let first = first_task.await.unwrap().unwrap();
        assert_eq!(openrouter_state.max_in_flight.load(Ordering::SeqCst), 2);
        (first, second)
    };

    if !live_openrouter {
        let local_client_url = spawn(zkapi_clientd::build_router(service.clone())).await;
        let response = reqwest::Client::new()
            .post(format!("{local_client_url}/v1/chat/completions"))
            .header("x-zkapi-session-id", "chat-one")
            .json(&json!({
                "model": "openai/gpt-4o-mini",
                "stream": true,
                "messages": [{"role": "user", "content": "stream prompt"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap(),
            "text/event-stream"
        );
        let mut chunks = response.bytes_stream();
        let first_chunk = tokio::time::timeout(Duration::from_millis(200), chunks.next())
            .await
            .expect("the first SSE chunk should not be buffered")
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&first_chunk).contains("answer: "));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), chunks.next())
                .await
                .is_err()
        );
        let second_chunk = tokio::time::timeout(Duration::from_secs(1), chunks.next())
            .await
            .expect("the delayed SSE chunk should remain readable")
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&second_chunk).contains("stream prompt"));
        drop(chunks);

        // OpenWebUI often connects to port 11434 as an Ollama backend rather
        // than as an OpenAI-compatible backend. Ollama streaming is NDJSON,
        // not SSE, and must also reach the caller one chunk at a time.
        let response = reqwest::Client::new()
            .post(format!("{local_client_url}/api/chat"))
            .header("x-zkapi-session-id", "chat-one")
            .json(&json!({
                "model": "openai/gpt-4o-mini",
                "stream": true,
                "messages": [{"role": "user", "content": "ollama stream prompt"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap(),
            "application/x-ndjson"
        );
        let mut chunks = response.bytes_stream();
        let first_chunk = tokio::time::timeout(Duration::from_millis(200), chunks.next())
            .await
            .expect("the first Ollama chunk should not be buffered")
            .unwrap()
            .unwrap();
        let first: Value = serde_json::from_slice(&first_chunk).unwrap();
        assert_eq!(first["message"]["content"], "answer: ");
        assert_eq!(first["done"], false);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), chunks.next())
                .await
                .is_err()
        );
        let second_chunk = tokio::time::timeout(Duration::from_secs(1), chunks.next())
            .await
            .expect("the delayed Ollama chunk should remain readable")
            .unwrap()
            .unwrap();
        let second: Value = serde_json::from_slice(&second_chunk).unwrap();
        assert_eq!(second["message"]["content"], "ollama stream prompt");
        assert_eq!(second["done"], false);
        let final_chunk = tokio::time::timeout(Duration::from_secs(1), chunks.next())
            .await
            .expect("the final Ollama chunk should be emitted")
            .unwrap()
            .unwrap();
        let final_chunk: Value = serde_json::from_slice(&final_chunk).unwrap();
        assert_eq!(final_chunk["message"]["content"], "");
        assert_eq!(final_chunk["done"], true);
        drop(chunks);
    }

    let active = service.zkapi_config().await.active_lease.unwrap();
    assert_eq!(active.client_request_id, first.client_request_id);
    assert_eq!(
        active.session_id,
        if live_openrouter {
            "default"
        } else {
            "chat-one"
        }
    );
    service.settle_for_withdrawal().await.unwrap();

    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let wallet_settled = !service.status().await.unwrap().pending_request;
            let first_settled = store
                .lookup_openrouter_lease(&first.client_request_id)
                .is_some_and(|lease| lease.status == "finalized");
            let mock_keys_settled = live_openrouter
                || (*openrouter_state.deletes.lock().unwrap() == 1
                    && openrouter_state.create_bodies.lock().unwrap().len() == 1);
            if wallet_settled && first_settled && mock_keys_settled {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("explicit settlement should finish without waiting for key expiry");

    assert_eq!(first.client_request_id, second.client_request_id);
    if live_openrouter {
        assert!(
            first.payload.as_ref().unwrap()["choices"][0]["message"]["content"]
                .as_str()
                .is_some_and(|content| !content.is_empty())
        );
        assert!(
            second.payload.as_ref().unwrap()["choices"][0]["message"]["content"]
                .as_str()
                .is_some_and(|content| !content.is_empty())
        );
    } else {
        assert_eq!(
            first.payload.as_ref().unwrap()["choices"][0]["message"]["content"],
            "answer: private prompt one"
        );
        assert_eq!(
            second.payload.as_ref().unwrap()["choices"][0]["message"]["content"],
            "answer: private prompt two"
        );
        let prompts = openrouter_state.prompts.lock().unwrap().clone();
        let mut parallel_prompts = prompts[..2].to_vec();
        parallel_prompts.sort();
        assert_eq!(
            parallel_prompts,
            ["private prompt one", "private prompt two"]
        );
        assert_eq!(&prompts[2..], ["stream prompt", "ollama stream prompt"]);
        assert_eq!(*openrouter_state.inference_attempts.lock().unwrap(), 5);
        assert_eq!(openrouter_state.create_bodies.lock().unwrap().len(), 1);
        for create_body in openrouter_state.create_bodies.lock().unwrap().iter() {
            assert_eq!(create_body["limit"], 0.001);
            assert_eq!(create_body["include_byok_in_limit"], true);
            assert!(create_body["expires_at"].as_str().unwrap().ends_with('Z'));
        }
    }

    let lease = store
        .lookup_openrouter_lease(&first.client_request_id)
        .unwrap();
    assert_eq!(lease.status, "finalized");
    assert!(!lease.api_request.payload.contains("private prompt"));
    assert!(!serde_json::to_string(&lease.api_request)
        .unwrap()
        .contains("sk-or-v1-"));
    let cross_mode_replay = reqwest::Client::new()
        .post(format!("{protocol_server_url}/v2/requests"))
        .json(&lease.api_request)
        .send()
        .await
        .unwrap();
    assert_eq!(cross_mode_replay.status(), StatusCode::CONFLICT);
    assert_eq!(
        store
            .lookup_by_client_id(&first.client_request_id)
            .unwrap()
            .status,
        zkapi_types::NullifierStatus::Finalized
    );
    let expected_total_charge = zkapi_serverd::pricing::usd_to_credits(4.0 * 0.000006);
    let recovered_balance = service
        .status()
        .await
        .unwrap()
        .note
        .unwrap()
        .current_balance;
    if live_openrouter {
        assert!(recovered_balance < deposit);
    } else {
        assert_eq!(recovered_balance, deposit - expected_total_charge);
        assert_eq!(*openrouter_state.deletes.lock().unwrap(), 1);
    }
    let transcript = store.lookup_by_client_id(&first.client_request_id).unwrap();
    if live_openrouter {
        assert!(transcript.charge_applied.is_some_and(|charge| charge > 0));
    } else {
        assert_eq!(transcript.charge_applied, Some(expected_total_charge));
    }
    assert!(!transcript
        .response_payload
        .as_deref()
        .unwrap_or_default()
        .contains("private prompt"));

    // The ordinary proxy route remains live on the same server and, unlike
    // direct mode, EchoProvider sees/echoes the request body.
    let mut proxy_wallet = Wallet::new(ClientConfig {
        protocol_version: 2,
        chain_id: 1,
        contract_address: contract,
        request_charge_cap: request_cap,
        policy_charge_cap: request_cap,
        policy_enabled: false,
        server_url: protocol_server_url,
        state_dir: wallet_directory.to_string_lossy().to_string(),
        trusted_epoch_roots: Vec::new(),
        proof_mode: ClientProofMode::Groth16 {
            setup_dir: setup_directory,
        },
        state_signing_key: state_key,
        clearance_signing_key: clearance_key,
    })
    .unwrap();
    let proxy_payload = serde_json::to_string(&CoreRequest::post_json(
        "/v1/chat/completions",
        json!({"model": "demo", "messages": [{"role": "user", "content": "proxy prompt"}]}),
    ))
    .unwrap();
    let proxy_siblings = tree.read().unwrap().get_siblings(0).to_vec();
    let proxy_response = proxy_wallet
        .request_flow(
            &proxy_payload,
            zkapi_types::canonical_payload_hash(proxy_payload.as_bytes()),
            root,
            proxy_siblings,
        )
        .await
        .unwrap();
    assert!(proxy_response.response_payload.contains("proxy prompt"));
    assert_eq!(proxy_response.charge_applied, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oa_org_lease_is_verified_before_prompt_goes_to_openrouter() {
    let directory = test_directory();
    let wallet_directory = directory.join("wallet");
    let contract = Felt252::from_u64(0x0a0a);
    let deposit = 10_000u128;
    let request_cap = 1_000u128;
    let setup_directory = setup_directory();
    let expiry = 4_000_000_000u64;

    let state_seed = Felt252::from_u64(31);
    let clear_seed = Felt252::from_u64(32);
    let signer = Arc::new(ServerSigner::new(&state_seed, &clear_seed));
    let state_key = signer.state_public_key();
    let clearance_key = signer.clearance_public_key();

    let mut seed_wallet = Wallet::new(ClientConfig {
        protocol_version: 2,
        chain_id: 1,
        contract_address: contract,
        request_charge_cap: request_cap,
        policy_charge_cap: request_cap,
        policy_enabled: false,
        server_url: "http://127.0.0.1:1".to_string(),
        state_dir: wallet_directory.to_string_lossy().to_string(),
        trusted_epoch_roots: Vec::new(),
        proof_mode: ClientProofMode::Groth16 {
            setup_dir: setup_directory.clone(),
        },
        state_signing_key: state_key.clone(),
        clearance_signing_key: clearance_key.clone(),
    })
    .unwrap();
    let (secret, registration) = seed_wallet.generate_deposit_params();
    seed_wallet
        .confirm_deposit(secret, 0, deposit, expiry)
        .unwrap();

    let mut tree = MerkleTree::new();
    tree.insert(core::note_leaf(0, &registration, deposit, expiry));
    let tree = Arc::new(RwLock::new(tree));
    let root = tree.read().unwrap().root();
    let indexer_url = spawn(indexer_router(tree)).await;

    let flow = OaFlowState::default();
    let live_org_url = std::env::var("LIVE_OA_ORG_URL").ok();
    let live_org = live_org_url.is_some();
    let (org_url, org_secret, verifier_url, trusted_inference_base) =
        if let Some(org_url) = live_org_url {
            (
                org_url,
                std::env::var("LIVE_OA_ORG_SHARED_SECRET")
                    .expect("LIVE_OA_ORG_SHARED_SECRET is required with LIVE_OA_ORG_URL"),
                "https://verifier2.openanonymity.ai".to_string(),
                "https://openrouter.ai/api/v1".to_string(),
            )
        } else {
            *flow.verifier_rejections_remaining.lock().unwrap() = 1;
            // The first key becomes unusable while its signed expiration is
            // still in the future. The client must retire it and retry the
            // inference with a freshly issued and verified key.
            *flow.inference_auth_failures_remaining.lock().unwrap() = 1;
            let verifier_url = spawn(oa_verifier_router(flow.clone())).await;
            let inference_url = spawn(oa_inference_router(flow.clone())).await;
            let trusted_inference_base = format!("{inference_url}/v1");
            let org_url = spawn(oa_org_router(
                flow.clone(),
                verifier_url.clone(),
                inference_url,
            ))
            .await;
            (
                org_url,
                "oa-org-test-secret".to_string(),
                verifier_url,
                trusted_inference_base,
            )
        };

    let store = Arc::new(NullifierStore::new(directory.join("server.db")).unwrap());
    let processor = Arc::new(
        RequestProcessor::try_new(
            ServerConfig {
                protocol_version: 2,
                chain_id: 1,
                contract_address: contract,
                request_charge_cap: request_cap,
                policy_charge_cap: request_cap,
                policy_enabled: false,
                provider_kind: ProviderKind::Echo,
                echo_fixed_charge: 1,
                db_path: directory.join("server.db").to_string_lossy().to_string(),
                state_seed,
                clear_seed,
                initial_root: root,
                proof_setup_dir: setup_directory.clone(),
                openrouter_leases: Some(OpenRouterLeaseConfig {
                    source: OpenRouterLeaseSourceConfig::OaOrg {
                        org_base_url: org_url,
                        shared_secret: org_secret,
                    },
                    ttl_seconds: 60,
                    settlement_grace_seconds: 0,
                    settlement_poll_seconds: 1,
                }),
                ..Default::default()
            },
            store.clone(),
            signer,
            Arc::new(EchoProvider::new(1)),
            root,
        )
        .unwrap(),
    );
    let protocol_server_url = spawn(create_router(processor)).await;
    let auth_config = AuthConfig {
        protocol_version: 2,
        chain_id: 1,
        contract_address: contract,
        request_charge_cap: request_cap,
        policy_charge_cap: request_cap,
        policy_enabled: false,
        protocol_server_url: protocol_server_url.clone(),
        indexer_url: indexer_url.clone(),
        state_dir: wallet_directory.clone(),
        models: vec![ModelDescriptor::new("openai/gpt-4o-mini")],
        proof_setup_dir: setup_directory.clone(),
        state_signing_key: state_key.clone(),
        clearance_signing_key: clearance_key.clone(),
        request_mode: RequestMode::DirectOpenrouter,
        oa_verifier_url: verifier_url,
        openrouter_inference_base: trusted_inference_base,
        require_oa_org_key_source: true,
        ..Default::default()
    };
    let service = AuthService::new(auth_config.clone()).unwrap();

    let response = service
        .execute_request(CoreRequest::post_json(
            "/v1/chat/completions",
            json!({
                "model": "openai/gpt-4o-mini",
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "verifier protected prompt"}]
            }),
        ))
        .await
        .unwrap();
    let payload = response.payload.unwrap();
    assert!(payload["choices"]
        .as_array()
        .is_some_and(|items| !items.is_empty()));
    if !live_org {
        assert_eq!(
            payload["choices"][0]["message"]["content"],
            "verified: verifier protected prompt"
        );
        assert_eq!(
            flow.events.lock().unwrap().as_slice(),
            [
                "issued",
                "verified",
                "inference_rejected",
                "issued",
                "verified",
                "inference"
            ]
        );
        assert_eq!(flow.verifier_requests.lock().unwrap().len(), 2);
        assert_eq!(*flow.verifier_attempts.lock().unwrap(), 3);
        assert_eq!(
            flow.prompts.lock().unwrap().as_slice(),
            ["verifier protected prompt"]
        );
        let org_requests = flow.org_requests.lock().unwrap();
        assert_eq!(org_requests.len(), 2);
        assert_ne!(
            org_requests[0]["client_request_id"],
            org_requests[1]["client_request_id"]
        );
        assert!(!org_requests[0]
            .to_string()
            .contains("verifier protected prompt"));
    }
    let lease = store
        .lookup_openrouter_lease(&response.client_request_id)
        .unwrap();
    assert_eq!(lease.key_source, "oa_org");
    if !live_org {
        {
            let verifier_requests = flow.verifier_requests.lock().unwrap();
            assert_eq!(
                verifier_requests[1]["key_valid_till"].as_u64(),
                Some(lease.expires_at + 30)
            );
        }
        let first_lease_id = flow.org_requests.lock().unwrap()[0]["client_request_id"]
            .as_str()
            .unwrap()
            .to_string();
        let retired = store.lookup_openrouter_lease(&first_lease_id).unwrap();
        assert_eq!(retired.status, "finalized");
        assert_eq!(retired.charge_applied, Some(7));

        // The successful replacement key remains active for its lease window.
        assert_eq!(lease.status, "active");

        // A replacement daemon has no copy of that once-returned key. It must
        // retire and recover the active lease before issuing a new one.
        let restarted = AuthService::new(auth_config).unwrap();
        let after_restart = restarted
            .execute_request(CoreRequest::post_json(
                "/v1/chat/completions",
                json!({
                    "model": "openai/gpt-4o-mini",
                    "max_tokens": 16,
                    "messages": [{"role": "user", "content": "prompt after restart"}]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(
            after_restart.payload.as_ref().unwrap()["choices"][0]["message"]["content"],
            "verified: prompt after restart"
        );
        assert_ne!(after_restart.client_request_id, response.client_request_id);
        assert_eq!(
            store
                .lookup_openrouter_lease(&response.client_request_id)
                .unwrap()
                .status,
            "finalized"
        );
        assert_eq!(
            store
                .lookup_openrouter_lease(&after_restart.client_request_id)
                .unwrap()
                .status,
            "active"
        );
        let settled = restarted.settle_for_withdrawal().await.unwrap();
        assert!(!settled.pending_request);
        assert_eq!(
            store
                .lookup_openrouter_lease(&after_restart.client_request_id)
                .unwrap()
                .status,
            "finalized"
        );
        assert_eq!(flow.org_requests.lock().unwrap().len(), 3);
        assert_eq!(
            flow.prompts.lock().unwrap().as_slice(),
            ["verifier protected prompt", "prompt after restart"]
        );
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
