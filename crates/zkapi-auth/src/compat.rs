use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::config::ModelDescriptor;
use crate::service::{CoreRequest, CoreResponse};

pub fn core_request(path: &str, body: Value) -> CoreRequest {
    CoreRequest::post_json(path, body)
}

pub fn extract_model(body: &Value, fallback: &str) -> String {
    body.get("model")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

pub fn openai_models(models: &[ModelDescriptor]) -> Value {
    Value::Object(serde_json::Map::from_iter([
        ("object".to_string(), Value::String("list".to_string())),
        (
            "data".to_string(),
            Value::Array(
                models
                    .iter()
                    .map(|model| {
                        json!({
                            "id": model.id,
                            "object": "model",
                            "created": 0,
                            "owned_by": model.owned_by,
                        })
                    })
                    .collect(),
            ),
        ),
    ]))
}

pub fn ollama_tags(models: &[ModelDescriptor]) -> Value {
    json!({
        "models": models
            .iter()
            .map(|model| {
                json!({
                    "name": model.id,
                    "model": model.id,
                    "modified_at": "1970-01-01T00:00:00Z",
                    "size": 0,
                    "digest": "zkapi",
                    "details": {
                        "format": "zkapi",
                        "family": "proxy",
                        "parameter_size": "n/a",
                        "quantization_level": "n/a",
                    },
                })
            })
            .collect::<Vec<_>>()
    })
}

pub fn chat_completion(model: &str, response: &CoreResponse) -> Value {
    if let Some(existing) = response
        .payload
        .as_ref()
        .filter(|value| value.get("choices").is_some())
    {
        return existing.clone();
    }

    let content = response_text(response);
    json!({
        "id": format!("chatcmpl-{}", response.client_request_id),
        "object": "chat.completion",
        "created": now_epoch_seconds(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": content },
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
        "zkapi": response_metadata(response),
    })
}

pub fn responses_api(model: &str, response: &CoreResponse) -> Value {
    if let Some(existing) = response
        .payload
        .as_ref()
        .filter(|value| value.get("output").is_some())
    {
        return existing.clone();
    }

    let content = response_text(response);
    json!({
        "id": format!("resp_{}", response.client_request_id),
        "object": "response",
        "created_at": now_epoch_seconds(),
        "status": "completed",
        "model": model,
        "output": [{
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "output_text",
                "text": content,
            }],
        }],
        "zkapi": response_metadata(response),
    })
}

pub fn ollama_chat(model: &str, response: &CoreResponse) -> Value {
    if let Some(existing) = response
        .payload
        .as_ref()
        .filter(|value| value.get("message").is_some())
    {
        return existing.clone();
    }

    let content = response_text(response);
    json!({
        "model": model,
        "created_at": "1970-01-01T00:00:00Z",
        "message": {
            "role": "assistant",
            "content": content,
        },
        "done": true,
        "done_reason": "stop",
        "total_duration": 0,
        "load_duration": 0,
        "prompt_eval_count": 0,
        "eval_count": 0,
        "zkapi": response_metadata(response),
    })
}

fn response_text(response: &CoreResponse) -> String {
    match response.payload.as_ref() {
        Some(Value::String(text)) => text.clone(),
        Some(value) => value.to_string(),
        None => response.raw_payload.clone(),
    }
}

fn response_metadata(response: &CoreResponse) -> Value {
    json!({
        "response_code": response.response_code,
        "charge_applied": response.charge_applied,
        "remaining_balance": response.remaining_balance,
        "next_anchor": response.next_anchor,
    })
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use zkapi_types::Felt252;

    use super::*;

    fn response(payload: Option<Value>) -> CoreResponse {
        CoreResponse {
            client_request_id: "req-1".to_string(),
            response_code: 200,
            raw_payload: payload.clone().unwrap_or_else(|| json!("hi")).to_string(),
            payload,
            charge_applied: 7,
            next_anchor: Felt252::from_u64(9),
            remaining_balance: Some(42),
        }
    }

    #[test]
    fn chat_completion_passthroughs_existing_shape() {
        let payload = json!({
            "choices": [{ "message": { "role": "assistant", "content": "ok" } }]
        });
        let result = chat_completion("demo", &response(Some(payload.clone())));
        assert_eq!(result, payload);
    }

    #[test]
    fn chat_completion_synthesizes_shape() {
        let result = chat_completion("demo", &response(Some(json!({"foo": "bar"}))));
        assert_eq!(result["object"], "chat.completion");
        assert_eq!(result["model"], "demo");
        assert_eq!(
            result["choices"][0]["message"]["content"],
            "{\"foo\":\"bar\"}"
        );
    }

    #[test]
    fn ollama_tags_render_models() {
        let tags = ollama_tags(&[ModelDescriptor::new("demo")]);
        assert_eq!(tags["models"][0]["name"], "demo");
    }
}
