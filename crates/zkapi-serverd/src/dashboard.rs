//! Live dashboard feed for the zkAPI server.
//!
//! The server's durable transcript store deliberately keeps only a hash of the
//! request payload, not the prompt. The dashboard, by contrast, is meant to
//! show an operator *exactly* what the server sees and signs for each request —
//! decoded prompt, upstream response, token usage, the zk proof/nullifier/anchor
//! fields, the charge, and the freshly-signed next state. This module holds a
//! bounded in-memory feed of those rich events plus a broadcast channel that
//! powers the Server-Sent-Events stream. It is observability only; nothing here
//! affects protocol state.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;
use zkapi_types::wire::CurvePointWire;
use zkapi_types::Felt252;

use crate::pricing;
use crate::provider::UsageInfo;

/// A decoded chat message for display.
#[derive(Debug, Clone, Serialize)]
pub struct ChatMessageView {
    pub role: String,
    pub content: String,
}

/// One fully-detailed request as the server saw it.
#[derive(Debug, Clone, Serialize)]
pub struct DashboardEvent {
    pub seq: u64,
    pub ts_ms: u64,
    pub client_request_id: String,
    pub billing_label: String,
    pub upstream_model: Option<String>,

    // --- zk authentication / payment proof ---
    pub request_nullifier: Felt252,
    pub active_root: Felt252,
    pub anon_commitment: CurvePointWire,
    pub solvency_bound: u128,
    pub solvency_bound_usd: f64,
    pub statement_type: u8,
    pub state_sig_epoch_in: u32,
    pub proof_backend: String,
    pub proof_public_output_hash: Felt252,
    pub proof_size_bytes: usize,

    // --- request content (decoded; the server *does* see this in Mode 1) ---
    pub request_path: String,
    pub request_model: Option<String>,
    pub request_messages: Vec<ChatMessageView>,
    pub request_raw: String,

    // --- upstream response ---
    pub response_code: u16,
    pub response_text: String,
    pub response_hash: Felt252,

    // --- token usage + billing ---
    pub usage: Option<UsageInfo>,
    pub charge_applied: u128,
    pub charge_usd: f64,

    // --- next state the server signed ---
    pub next_commitment: CurvePointWire,
    pub next_anchor: Felt252,
    pub blind_delta_srv: Felt252,
    pub next_state_sig_epoch: u32,
    pub next_state_sig_leaf_index: u64,
    pub next_state_sig_root: Felt252,

    // --- timing ---
    pub upstream_ms: u64,
    pub total_ms: u64,
}

/// Running totals across all requests seen this process lifetime.
#[derive(Debug, Clone, Default, Serialize)]
pub struct DashboardTotals {
    pub request_count: u64,
    pub total_credits_charged: u128,
    pub total_cost_usd: f64,
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_tokens: u64,
}

/// Bounded in-memory feed + broadcast hub.
pub struct DashboardHub {
    tx: broadcast::Sender<DashboardEvent>,
    recent: Mutex<VecDeque<DashboardEvent>>,
    totals: Mutex<DashboardTotals>,
    seq: Mutex<u64>,
    capacity: usize,
    pub started_ms: u64,
}

impl DashboardHub {
    pub fn new(capacity: usize) -> Self {
        let (tx, _rx) = broadcast::channel(256);
        Self {
            tx,
            recent: Mutex::new(VecDeque::with_capacity(capacity)),
            totals: Mutex::new(DashboardTotals::default()),
            seq: Mutex::new(0),
            capacity,
            started_ms: now_ms(),
        }
    }

    /// Allocate the next monotonic sequence number for an event.
    pub fn next_seq(&self) -> u64 {
        let mut seq = self.seq.lock().unwrap();
        *seq += 1;
        *seq
    }

    /// Record an event: update totals, append to the ring buffer, broadcast.
    pub fn record(&self, event: DashboardEvent) {
        {
            let mut totals = self.totals.lock().unwrap();
            totals.request_count += 1;
            totals.total_credits_charged = totals
                .total_credits_charged
                .saturating_add(event.charge_applied);
            totals.total_cost_usd += event.charge_usd;
            if let Some(usage) = &event.usage {
                totals.total_prompt_tokens = totals
                    .total_prompt_tokens
                    .saturating_add(usage.prompt_tokens);
                totals.total_completion_tokens = totals
                    .total_completion_tokens
                    .saturating_add(usage.completion_tokens);
                totals.total_tokens = totals.total_tokens.saturating_add(usage.total_tokens);
            }
        }
        {
            let mut recent = self.recent.lock().unwrap();
            if recent.len() >= self.capacity {
                recent.pop_front();
            }
            recent.push_back(event.clone());
        }
        // A send error just means no subscribers; that's fine.
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<DashboardEvent> {
        self.tx.subscribe()
    }

    pub fn recent(&self) -> Vec<DashboardEvent> {
        self.recent.lock().unwrap().iter().cloned().collect()
    }

    pub fn totals(&self) -> DashboardTotals {
        self.totals.lock().unwrap().clone()
    }
}

/// Decode the `{method,path,headers,body}` envelope (or a bare body) into the
/// display fields: path, model, and chat messages.
pub fn decode_request_view(payload: &str) -> (String, Option<String>, Vec<ChatMessageView>) {
    let value: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return ("/v1/chat/completions".to_string(), None, Vec::new()),
    };
    let (path, body) = if value.get("path").is_some() && value.get("body").is_some() {
        (
            value
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("/v1/chat/completions")
                .to_string(),
            value.get("body").cloned().unwrap_or(Value::Null),
        )
    } else {
        ("/v1/chat/completions".to_string(), value)
    };

    let model = body
        .get("model")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());

    let mut messages = Vec::new();
    if let Some(arr) = body.get("messages").and_then(|m| m.as_array()) {
        for msg in arr {
            let role = msg
                .get("role")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string();
            let content = stringify_content(msg.get("content"));
            messages.push(ChatMessageView { role, content });
        }
    }
    (path, model, messages)
}

/// Flatten OpenAI message content (string, or array of parts) to text.
fn stringify_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => {
            let mut out = String::new();
            for part in parts {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    out.push_str(text);
                } else if let Some(kind) = part.get("type").and_then(|t| t.as_str()) {
                    out.push_str(&format!("[{kind}]"));
                }
            }
            out
        }
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// USD value of a credit amount (for display).
pub fn charge_usd(credits: u128) -> f64 {
    pricing::credits_to_usd(credits)
}

/// Mask bearer-style API keys (`sk-...`) before they reach the dashboard feed
/// so a secret bearer token never lands in a dashboard, screen-share, or log.
pub fn redact_secrets(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find("sk-") {
        result.push_str(&rest[..pos]);
        let after = &rest[pos..];
        let end = after
            .char_indices()
            .find(|&(idx, c)| idx >= 3 && !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .map(|(idx, _)| idx)
            .unwrap_or(after.len());
        if end > 12 {
            result.push_str("sk-***REDACTED***");
        } else {
            result.push_str(&after[..end]);
        }
        rest = &after[end..];
    }
    result.push_str(rest);
    result
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_request_view_extracts_messages() {
        let payload = r#"{"path":"/v1/chat/completions","body":{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}}"#;
        let (path, model, messages) = decode_request_view(payload);
        assert_eq!(path, "/v1/chat/completions");
        assert_eq!(model.unwrap(), "gpt-4o-mini");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "hello");
    }

    #[test]
    fn redact_masks_bearer_keys() {
        let s = r#"{"api_key":"sk-or-v1-3527c84aabcdef0123456789","request_id":"49802767d5a1"}"#;
        let red = redact_secrets(s);
        assert!(!red.contains("sk-or-v1-3527"), "key not redacted: {red}");
        assert!(red.contains("sk-***REDACTED***"));
        assert!(red.contains("49802767d5a1"), "request id should survive");
        // Short non-key strings are untouched.
        assert_eq!(redact_secrets("sk-1"), "sk-1");
        // Unicode content is preserved around a redaction.
        let u = redact_secrets("héllo sk-proj-ABCDEFGHIJKLMNOP wörld");
        assert!(u.contains("héllo") && u.contains("wörld") && u.contains("REDACTED"));
    }

    #[test]
    fn stringify_handles_multimodal_parts() {
        let content = serde_json::json!([
            {"type":"text","text":"describe"},
            {"type":"image_url","image_url":{"url":"data:..."}}
        ]);
        assert_eq!(stringify_content(Some(&content)), "describe[image_url]");
    }

    #[test]
    fn hub_tracks_totals_and_ring_buffer() {
        let hub = DashboardHub::new(2);
        for i in 0..3 {
            hub.record(sample_event(hub.next_seq(), i + 1));
        }
        let totals = hub.totals();
        assert_eq!(totals.request_count, 3);
        assert_eq!(totals.total_credits_charged, 6); // 1 + 2 + 3
                                                     // Ring buffer capped at 2.
        assert_eq!(hub.recent().len(), 2);
    }

    fn sample_event(seq: u64, charge: u128) -> DashboardEvent {
        DashboardEvent {
            seq,
            ts_ms: 0,
            client_request_id: format!("req-{seq}"),
            billing_label: "passthrough:openrouter".to_string(),
            upstream_model: Some("gpt-4o-mini".to_string()),
            request_nullifier: Felt252::from_u64(seq),
            active_root: Felt252::ZERO,
            anon_commitment: CurvePointWire {
                x: Felt252::ZERO,
                y: Felt252::ZERO,
            },
            solvency_bound: 1_000_000,
            solvency_bound_usd: 1.0,
            statement_type: 1,
            state_sig_epoch_in: 0,
            proof_backend: "dev_witness_envelope".to_string(),
            proof_public_output_hash: Felt252::ZERO,
            proof_size_bytes: 100,
            request_path: "/v1/chat/completions".to_string(),
            request_model: Some("gpt-4o-mini".to_string()),
            request_messages: Vec::new(),
            request_raw: "{}".to_string(),
            response_code: 200,
            response_text: "{}".to_string(),
            response_hash: Felt252::ZERO,
            usage: None,
            charge_applied: charge,
            charge_usd: charge_usd(charge),
            next_commitment: CurvePointWire {
                x: Felt252::ZERO,
                y: Felt252::ZERO,
            },
            next_anchor: Felt252::ZERO,
            blind_delta_srv: Felt252::ZERO,
            next_state_sig_epoch: 1,
            next_state_sig_leaf_index: 0,
            next_state_sig_root: Felt252::ZERO,
            upstream_ms: 0,
            total_ms: 0,
        }
    }
}
