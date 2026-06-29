//! Token-usage-metered upstream provider.
//!
//! This is the `ApiProvider` that makes zkAPI bill on *real* spend. It serves
//! the two billing modes the OpenAnonymity integration needs:
//!
//! **Mode 1 — pass-through.** The zkAPI payload is a `{method,path,headers,body}`
//! envelope. We decode it, forward `body` to `{upstream_api_base}{path}` with the
//! server-held API key, read the upstream's token `usage`, convert cost → credits
//! (`pricing`), and return that as `charge_applied`. OpenRouter self-reports
//! `usage.cost`; OpenAI is priced from the built-in table. The server sees the
//! prompt in this mode.
//!
//! **Mode 2 — ephemeral key (OpenRouter, "oa-chat style").** Two special paths:
//!   * `/zkapi/v1/ephemeral_key` — mint a credit-limited OpenRouter runtime key
//!     (charge 0; usage billed later). The browser then streams from OpenRouter
//!     *directly*, so the server never sees the prompt.
//!   * `/zkapi/v1/ephemeral_settle` — charge for a generation the browser ran on
//!     a previously-issued key, using the OpenRouter-authoritative per-response
//!     `cost`. The key's hard credit limit bounds total exposure, and we attach
//!     the provider-side aggregate usage for audit.
//!
//! The decode is read-only: the zkAPI `payload_hash` (bound by the proof) is
//! never altered. We only augment what we forward upstream (adding
//! `usage.include` for OpenRouter so it returns cost).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;
use zkapi_types::Felt252;

use crate::config::MeteredConfig;
use crate::error::ServerError;
use crate::openrouter::{unix_to_iso8601, OpenRouterProvisioner};
use crate::pricing;
use crate::provider::{compute_response_hash, ApiProvider, ProviderResponse, UsageInfo};

/// Special request paths handled internally rather than forwarded upstream.
pub const PATH_EPHEMERAL_ISSUE: &str = "/zkapi/v1/ephemeral_key";
pub const PATH_EPHEMERAL_SETTLE: &str = "/zkapi/v1/ephemeral_settle";

/// Generous limit (USD) for the lazily-minted server-owned OpenRouter
/// inference key used for pass-through; the operator's account balance is the
/// real cap.
const SERVER_INFERENCE_KEY_LIMIT_USD: f64 = 1000.0;

/// Which upstream a pass-through request routes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Upstream {
    OpenAi,
    OpenRouter,
}

/// Route a pass-through request by its model id: a vendor-prefixed id
/// (`openai/…`, `anthropic/…`, `google/…`) is an OpenRouter model; a bare id
/// (`gpt-4o-mini`) is OpenAI.
fn route_upstream(model: Option<&str>) -> Upstream {
    match model {
        Some(m) if m.contains('/') => Upstream::OpenRouter,
        _ => Upstream::OpenAi,
    }
}

/// A token-usage-metered provider supporting both OpenAI and OpenRouter at once.
pub struct MeteredProvider {
    http: reqwest::Client,
    config: MeteredConfig,
    /// OpenRouter management/provisioning client (mints ephemeral + inference keys).
    provisioner: Option<Arc<OpenRouterProvisioner>>,
    /// Lazily-minted server-owned OpenRouter inference key for pass-through.
    or_inference_key: AsyncMutex<Option<String>>,
    /// Per-ephemeral-key cumulative (reported_usd, charged_credits), so each
    /// settle can bill at least the provider-authoritative aggregate delta.
    settled: Mutex<HashMap<String, (f64, u128)>>,
    /// Hard upper bound on a single charge (credits); mirrors the protocol cap
    /// so a metered request never gets rejected post-execution for exceeding it.
    charge_cap_credits: u128,
}

/// Minimal view of an OpenAI/OpenRouter chat-completion `usage` block.
#[derive(Debug, Deserialize, Default)]
struct UpstreamUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
    /// OpenRouter-only: real USD cost of the call.
    #[serde(default)]
    cost: Option<f64>,
}

impl MeteredProvider {
    pub fn new(config: MeteredConfig, charge_cap_credits: u128) -> Result<Self, ServerError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| ServerError::Internal(format!("failed to build metered client: {e}")))?;
        let provisioner = match &config.openrouter_key {
            Some(key) if !key.is_empty() => Some(Arc::new(OpenRouterProvisioner::new(
                key.clone(),
                config.openrouter_api_base.clone(),
                Duration::from_secs(30),
            )?)),
            _ => None,
        };
        Ok(Self {
            http,
            config,
            provisioner,
            or_inference_key: AsyncMutex::new(None),
            settled: Mutex::new(HashMap::new()),
            charge_cap_credits,
        })
    }

    /// Get (or lazily mint) an OpenRouter runtime key usable for pass-through
    /// inference. Prefers a configured dedicated key; otherwise mints one from
    /// the management key and caches it for the process lifetime.
    async fn openrouter_inference_key(&self) -> Result<String, ServerError> {
        if let Some(k) = &self.config.openrouter_inference_key {
            if !k.is_empty() {
                return Ok(k.clone());
            }
        }
        let mut guard = self.or_inference_key.lock().await;
        if let Some(k) = &*guard {
            return Ok(k.clone());
        }
        let provisioner = self.provisioner.as_ref().ok_or_else(|| {
            ServerError::InvalidRequest(
                "OpenRouter is not configured on this server (no OpenRouter key)".to_string(),
            )
        })?;
        let created = provisioner
            .create_key(
                "zkapi-oa-server-inference",
                SERVER_INFERENCE_KEY_LIMIT_USD,
                None,
            )
            .await?;
        tracing::info!("minted server-owned OpenRouter inference key for pass-through");
        *guard = Some(created.key.clone());
        Ok(created.key)
    }

    fn clamp_charge(&self, credits: u128) -> u128 {
        if credits > self.charge_cap_credits {
            tracing::warn!(
                "metered charge {} exceeds cap {}; clamping",
                credits,
                self.charge_cap_credits
            );
            self.charge_cap_credits
        } else {
            credits
        }
    }

    /// Mode 1: pass-through inference, routed per request to the upstream that
    /// matches the model id, billed at that upstream's real cost.
    async fn execute_passthrough(
        &self,
        path: &str,
        body: Value,
    ) -> Result<ProviderResponse, ServerError> {
        // Normalize any chat-style shim path (OpenAI /v1/chat/completions, Ollama
        // /api/chat, OpenAI Responses /v1/responses) to the upstream chat
        // endpoint + an OpenAI-shaped body.
        let (upstream_path, mut body) = normalize_chat_request(path, body);
        let request_model = body
            .get("model")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string());

        // Route by model id and resolve the base URL + key for that upstream.
        let upstream = route_upstream(request_model.as_deref());
        let (base, api_key) = match upstream {
            Upstream::OpenRouter => {
                let base = self.config.openrouter_api_base.trim_end_matches('/').to_string();
                let key = self.openrouter_inference_key().await?;
                // Force cost accounting so `usage.cost` is returned (and can't be
                // suppressed by the client to get mispriced).
                if let Value::Object(map) = &mut body {
                    map.insert("usage".to_string(), json!({ "include": true }));
                }
                (base, key)
            }
            Upstream::OpenAi => {
                let base = self.config.openai_api_base.trim_end_matches('/').to_string();
                let key = self.config.openai_api_key.clone().ok_or_else(|| {
                    ServerError::InvalidRequest(
                        "OpenAI is not configured on this server (no OpenAI key)".to_string(),
                    )
                })?;
                // Persist the completion on the OpenAI platform (default; honour
                // an explicit client value).
                if let Value::Object(map) = &mut body {
                    map.entry("store").or_insert(Value::Bool(true));
                }
                (base, key)
            }
        };
        let url = format!("{base}{upstream_path}");

        let mut req = self
            .http
            .post(&url)
            .bearer_auth(&api_key)
            .header("content-type", "application/json");
        if upstream == Upstream::OpenRouter {
            req = req
                .header("HTTP-Referer", "https://openanonymity.ai")
                .header("X-Title", "zkAPI x OpenAnonymity");
        }
        let resp = req
            .json(&body)
            .send()
            .await
            .map_err(|e| ServerError::Internal(format!("upstream request failed: {e}")))?;
        let status_code = resp.status().as_u16();
        let text = resp
            .text()
            .await
            .map_err(|e| ServerError::Internal(format!("upstream read failed: {e}")))?;

        // Parse usage + model from the response (best-effort).
        let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let response_model = parsed
            .get("model")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .or(request_model);
        let usage_raw: UpstreamUsage = parsed
            .get("usage")
            .and_then(|u| serde_json::from_value(u.clone()).ok())
            .unwrap_or_default();

        let (cost_usd, cost_source) =
            self.derive_cost(&usage_raw, response_model.as_deref(), upstream);
        let credits = self.clamp_charge(pricing::usd_to_credits(cost_usd));

        let usage = UsageInfo {
            prompt_tokens: usage_raw.prompt_tokens,
            completion_tokens: usage_raw.completion_tokens,
            total_tokens: if usage_raw.total_tokens > 0 {
                usage_raw.total_tokens
            } else {
                usage_raw.prompt_tokens + usage_raw.completion_tokens
            },
            cost_usd,
            cost_source,
        };

        let upstream_label = match upstream {
            Upstream::OpenAi => "openai",
            Upstream::OpenRouter => "openrouter",
        };
        Ok(ProviderResponse {
            status_code,
            response_hash: compute_response_hash(text.as_bytes()),
            payload: text,
            charge_applied: credits,
            policy_reason_code: None,
            policy_evidence_hash: None,
            usage: Some(usage),
            upstream_model: response_model,
            billing_label: format!("passthrough:{upstream_label}"),
        })
    }

    /// Derive (cost_usd, source) from upstream usage for the routed upstream.
    /// OpenRouter reports its exact cost; OpenAI is priced from the built-in
    /// per-model table.
    fn derive_cost(
        &self,
        usage: &UpstreamUsage,
        model: Option<&str>,
        upstream: Upstream,
    ) -> (f64, String) {
        if upstream == Upstream::OpenRouter {
            // We forced `usage.include`, so OpenRouter reports the authoritative
            // cost (including 0.0 for free models — don't re-price those).
            return (
                usage.cost.unwrap_or(0.0).max(0.0),
                "openrouter_reported".to_string(),
            );
        }
        match model {
            Some(model) => {
                let (cost, exact) =
                    pricing::openai_cost_usd(model, usage.prompt_tokens, usage.completion_tokens);
                let source = if exact {
                    "openai_table"
                } else {
                    "openai_table_fallback"
                };
                (cost, source.to_string())
            }
            None => (0.0, "unknown".to_string()),
        }
    }

    /// Mode 2 issue: mint a credit-limited ephemeral OpenRouter key.
    async fn execute_ephemeral_issue(
        &self,
        client_request_id: &str,
        body: Value,
    ) -> Result<ProviderResponse, ServerError> {
        let provisioner = self.provisioner.as_ref().ok_or_else(|| {
            ServerError::InvalidRequest(
                "ephemeral key issuance requires an OpenRouter provisioning key".to_string(),
            )
        })?;
        let requested_limit = body
            .get("limit_usd")
            .and_then(|v| v.as_f64())
            .unwrap_or(self.config.ephemeral_default_limit_usd)
            .max(0.0);
        // Never exceed the server default ceiling (bounds operator exposure).
        let limit_usd = requested_limit.min(self.config.ephemeral_default_limit_usd);
        let model = body
            .get("model")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string());

        // The key auto-expires after the configured TTL (default 60s). Follow-up
        // prompts reuse it until then; the browser settles the accumulated usage
        // when it expires.
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let expires_secs = now + self.config.ephemeral_ttl_seconds;
        let expires_at_iso = unix_to_iso8601(expires_secs);

        let name = format!("zkapi-oa-{}", &client_request_id[..client_request_id.len().min(16)]);
        let created = provisioner
            .create_key(&name, limit_usd, Some(&expires_at_iso))
            .await?;

        let payload = json!({
            "mode": "ephemeral_issue",
            "ephemeral_key": created.key,
            "key_hash": created.hash,
            "limit_usd": created.limit_usd.unwrap_or(limit_usd),
            "expires_at": created.expires_at.clone().unwrap_or(expires_at_iso),
            "expires_at_unix": expires_secs,
            "ttl_seconds": self.config.ephemeral_ttl_seconds,
            "model": model,
            "base_url": format!("{}/v1", self.config.openrouter_api_base.trim_end_matches('/')),
            "note": "Use this key to call OpenRouter directly; it expires soon. Settle accumulated usage via /zkapi/v1/ephemeral_settle.",
        });
        let payload = serde_json::to_string(&payload).unwrap_or_default();

        Ok(ProviderResponse {
            status_code: 200,
            response_hash: compute_response_hash(payload.as_bytes()),
            payload,
            charge_applied: 0, // issuance is free; usage billed at settle
            policy_reason_code: None,
            policy_evidence_hash: None,
            usage: Some(UsageInfo {
                cost_source: "ephemeral_issue".to_string(),
                ..Default::default()
            }),
            upstream_model: model_from(&body),
            billing_label: "ephemeral:issue".to_string(),
        })
    }

    /// Mode 2 settle: charge for a generation run on an issued ephemeral key.
    async fn execute_ephemeral_settle(
        &self,
        body: Value,
    ) -> Result<ProviderResponse, ServerError> {
        let key_hash = body
            .get("key_hash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ServerError::InvalidRequest("settle requires key_hash".to_string()))?
            .to_string();
        // OpenRouter-authoritative per-generation cost the browser observed.
        let reported_cost_usd = body
            .get("reported_cost_usd")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .max(0.0);
        let prompt_tokens = body
            .get("prompt_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let completion_tokens = body
            .get("completion_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let model = body
            .get("model")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string());

        // Read the provider-side authoritative aggregate usage (best-effort; it
        // is eventually-consistent and may lag the per-response cost).
        let (aggregate_usd, limit_usd, limit_remaining_usd) = match &self.provisioner {
            Some(p) => match p.get_key_usage(&key_hash).await {
                Ok(u) => (Some(u.usage_usd), u.limit_usd, u.limit_remaining_usd),
                Err(e) => {
                    tracing::warn!("settle: aggregate usage fetch failed: {e}");
                    (None, None, None)
                }
            },
            None => (None, None, None),
        };

        let reported_credits = pricing::usd_to_credits(reported_cost_usd);
        let prior_charged = self
            .settled
            .lock()
            .unwrap()
            .get(&key_hash)
            .map(|(_, c)| *c)
            .unwrap_or(0);
        // The authoritative outstanding amount = the provider aggregate (in
        // credits) not yet charged for this key. Charging at least this catches
        // a client that under-reports once the aggregate propagates; the
        // per-response report keeps it snappy in the common case.
        let aggregate_outstanding = aggregate_usd
            .map(|usd| pricing::usd_to_credits(usd).saturating_sub(prior_charged))
            .unwrap_or(0);
        let credits = self.clamp_charge(reported_credits.max(aggregate_outstanding));

        let (cumulative_usd, cumulative_charged) = {
            let mut settled = self.settled.lock().unwrap();
            let entry = settled.entry(key_hash.clone()).or_insert((0.0, 0));
            entry.0 += reported_cost_usd;
            entry.1 = entry.1.saturating_add(credits);
            (entry.0, entry.1)
        };

        let payload = json!({
            "mode": "ephemeral_settle",
            "key_hash": key_hash,
            "settled_usd": reported_cost_usd,
            "charged_credits": credits,
            "cumulative_settled_usd": cumulative_usd,
            "cumulative_charged_credits": cumulative_charged,
            "aggregate_usage_usd": aggregate_usd,
            "limit_usd": limit_usd,
            "limit_remaining_usd": limit_remaining_usd,
        });
        let payload = serde_json::to_string(&payload).unwrap_or_default();

        Ok(ProviderResponse {
            status_code: 200,
            response_hash: compute_response_hash(payload.as_bytes()),
            payload,
            charge_applied: credits,
            policy_reason_code: None,
            policy_evidence_hash: None,
            usage: Some(UsageInfo {
                prompt_tokens,
                completion_tokens,
                total_tokens: prompt_tokens + completion_tokens,
                cost_usd: reported_cost_usd,
                cost_source: "ephemeral_settle_reported".to_string(),
            }),
            upstream_model: model,
            billing_label: "ephemeral:settle".to_string(),
        })
    }
}

fn model_from(body: &Value) -> Option<String> {
    body.get("model")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
}

/// Coerce a chat-style shim request to the upstream's OpenAI chat-completions
/// endpoint + body. OpenAI `/v1/chat/completions` passes through; Ollama
/// `/api/chat` and OpenAI Responses `/v1/responses` are mapped to OpenAI chat
/// (Responses `input` → a user message; Ollama `options` → temperature/max).
/// Always forces non-streaming (the daemon path is non-streaming).
fn normalize_chat_request(path: &str, body: Value) -> (String, Value) {
    const UPSTREAM: &str = "/v1/chat/completions";
    let obj = body.as_object().cloned().unwrap_or_default();

    // Derive messages: prefer existing; else map Responses `input`.
    let messages = obj.get("messages").cloned().or_else(|| {
        obj.get("input").map(|input| match input {
            Value::String(s) => json!([{ "role": "user", "content": s }]),
            other => other.clone(),
        })
    });

    if path == UPSTREAM {
        // Already OpenAI chat; just force non-streaming.
        let mut map = obj;
        map.insert("stream".to_string(), Value::Bool(false));
        return (UPSTREAM.to_string(), Value::Object(map));
    }

    // Build a clean OpenAI body carrying only known-safe fields.
    let mut clean = serde_json::Map::new();
    for key in [
        "model",
        "temperature",
        "max_tokens",
        "top_p",
        "stop",
        "tools",
        "tool_choice",
        "response_format",
        "usage",
    ] {
        if let Some(v) = obj.get(key) {
            clean.insert(key.to_string(), v.clone());
        }
    }
    if let Some(messages) = messages {
        clean.insert("messages".to_string(), messages);
    }
    // Map a couple of common Ollama `options` to OpenAI fields.
    if let Some(Value::Object(opts)) = obj.get("options") {
        if let Some(t) = opts.get("temperature") {
            clean.entry("temperature").or_insert_with(|| t.clone());
        }
        if let Some(n) = opts.get("num_predict") {
            clean.entry("max_tokens").or_insert_with(|| n.clone());
        }
    }
    clean.insert("stream".to_string(), Value::Bool(false));
    (UPSTREAM.to_string(), Value::Object(clean))
}

/// Decode the `{method,path,headers,body}` zkAPI envelope into `(path, body)`.
///
/// Falls back gracefully: a bare body (no `path`) is treated as a chat
/// completion to the default path.
fn decode_envelope(payload: &str) -> (String, Value) {
    let value: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return ("/v1/chat/completions".to_string(), Value::Null),
    };
    let has_envelope = value.get("path").is_some() && value.get("body").is_some();
    if has_envelope {
        let path = value
            .get("path")
            .and_then(|p| p.as_str())
            .unwrap_or("/v1/chat/completions")
            .to_string();
        let body = value.get("body").cloned().unwrap_or(Value::Null);
        (path, body)
    } else {
        // Treat the whole payload as the body.
        ("/v1/chat/completions".to_string(), value)
    }
}

impl ApiProvider for MeteredProvider {
    fn execute<'a>(
        &'a self,
        client_request_id: &'a str,
        payload: &'a str,
        _payload_hash: &'a Felt252,
    ) -> Pin<Box<dyn Future<Output = Result<ProviderResponse, ServerError>> + Send + 'a>> {
        Box::pin(async move {
            let (path, body) = decode_envelope(payload);
            match path.as_str() {
                PATH_EPHEMERAL_ISSUE => self.execute_ephemeral_issue(client_request_id, body).await,
                PATH_EPHEMERAL_SETTLE => self.execute_ephemeral_settle(body).await,
                _ => self.execute_passthrough(&path, body).await,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_envelope_extracts_path_and_body() {
        let payload = r#"{"method":"POST","path":"/v1/chat/completions","headers":{},"body":{"model":"x","messages":[]}}"#;
        let (path, body) = decode_envelope(payload);
        assert_eq!(path, "/v1/chat/completions");
        assert_eq!(body.get("model").unwrap(), "x");
    }

    #[test]
    fn decode_envelope_handles_bare_body() {
        let payload = r#"{"model":"x","messages":[]}"#;
        let (path, body) = decode_envelope(payload);
        assert_eq!(path, "/v1/chat/completions");
        assert_eq!(body.get("model").unwrap(), "x");
    }

    #[test]
    fn normalize_passes_openai_chat_through() {
        let (path, body) = normalize_chat_request(
            "/v1/chat/completions",
            json!({ "model": "gpt-4o-mini", "messages": [{ "role": "user", "content": "hi" }] }),
        );
        assert_eq!(path, "/v1/chat/completions");
        assert_eq!(body["model"], "gpt-4o-mini");
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn normalize_maps_ollama_chat_to_openai() {
        let (path, body) = normalize_chat_request(
            "/api/chat",
            json!({ "model": "gpt-4o-mini", "messages": [{ "role": "user", "content": "hi" }], "options": { "temperature": 0.2, "num_predict": 64 } }),
        );
        assert_eq!(path, "/v1/chat/completions");
        assert_eq!(body["messages"][0]["content"], "hi");
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(body["max_tokens"], 64);
        assert_eq!(body["stream"], false);
        assert!(body.get("options").is_none(), "ollama options must be stripped");
    }

    #[test]
    fn normalize_maps_responses_input_to_messages() {
        let (path, body) = normalize_chat_request(
            "/v1/responses",
            json!({ "model": "gpt-4o-mini", "input": "summarize" }),
        );
        assert_eq!(path, "/v1/chat/completions");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "summarize");
    }

    #[test]
    fn decode_envelope_recognizes_ephemeral_paths() {
        let payload = r#"{"path":"/zkapi/v1/ephemeral_key","body":{"limit_usd":0.5}}"#;
        let (path, body) = decode_envelope(payload);
        assert_eq!(path, PATH_EPHEMERAL_ISSUE);
        assert_eq!(body.get("limit_usd").unwrap().as_f64().unwrap(), 0.5);
    }

    #[test]
    fn route_by_model_id() {
        assert_eq!(route_upstream(Some("gpt-4o-mini")), Upstream::OpenAi);
        assert_eq!(route_upstream(Some("gpt-4o")), Upstream::OpenAi);
        assert_eq!(route_upstream(Some("openai/gpt-4o-mini")), Upstream::OpenRouter);
        assert_eq!(
            route_upstream(Some("anthropic/claude-3.5-sonnet")),
            Upstream::OpenRouter
        );
        assert_eq!(route_upstream(None), Upstream::OpenAi);
    }

    #[test]
    fn derive_cost_openrouter_uses_reported() {
        let provider = MeteredProvider::new(MeteredConfig::default(), 1_000_000).unwrap();
        let usage = UpstreamUsage {
            prompt_tokens: 14,
            completion_tokens: 5,
            total_tokens: 19,
            cost: Some(0.0000051),
        };
        let (cost, source) = provider.derive_cost(&usage, Some("openai/gpt-4o-mini"), Upstream::OpenRouter);
        assert_eq!(source, "openrouter_reported");
        assert!((cost - 0.0000051).abs() < 1e-12);
    }

    #[test]
    fn derive_cost_openai_uses_table() {
        let provider = MeteredProvider::new(MeteredConfig::default(), 1_000_000).unwrap();
        let usage = UpstreamUsage {
            prompt_tokens: 14,
            completion_tokens: 5,
            total_tokens: 19,
            cost: None,
        };
        let (cost, source) = provider.derive_cost(&usage, Some("gpt-4o-mini-2024-07-18"), Upstream::OpenAi);
        assert_eq!(source, "openai_table");
        assert!((cost - 0.0000051).abs() < 1e-12);
    }
}
