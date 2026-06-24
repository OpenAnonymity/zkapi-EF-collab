//! API execution boundary for the zkAPI server.
//!
//! The zk layer and billing logic are protocol code. The actual upstream API
//! execution is application-specific, so the server uses a provider trait with
//! a small deterministic implementation for local development/tests.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use reqwest::header::{HeaderMap, HeaderValue};
use zkapi_types::Felt252;

use crate::config::{ProviderKind, ServerConfig};
use crate::error::ServerError;

/// Canonical hash binding an upstream response payload, matching what the
/// client wallet re-derives in `verify_request_response`.
fn compute_response_hash(payload: impl AsRef<[u8]>) -> Felt252 {
    zkapi_types::canonical_response_hash(payload.as_ref())
}

/// Result of executing the upstream API call.
#[derive(Debug, Clone)]
pub struct ProviderResponse {
    pub status_code: u16,
    pub payload: String,
    pub response_hash: Felt252,
    pub charge_applied: u128,
    pub policy_reason_code: Option<u32>,
    pub policy_evidence_hash: Option<Felt252>,
}

/// Application-specific API executor.
pub trait ApiProvider: Send + Sync {
    fn execute<'a>(
        &'a self,
        client_request_id: &'a str,
        payload: &'a str,
        payload_hash: &'a Felt252,
    ) -> Pin<Box<dyn Future<Output = Result<ProviderResponse, ServerError>> + Send + 'a>>;
}

/// Deterministic local provider used by tests and the default CLI server.
///
/// It echoes the payload back to the client and charges a fixed amount. The
/// `client_request_id` parameter exists to support idempotent implementations
/// in real deployments.
pub struct EchoProvider {
    fixed_charge: u128,
}

impl EchoProvider {
    pub fn new(fixed_charge: u128) -> Self {
        Self { fixed_charge }
    }
}

impl Default for EchoProvider {
    fn default() -> Self {
        Self { fixed_charge: 1 }
    }
}

impl ApiProvider for EchoProvider {
    fn execute<'a>(
        &'a self,
        _client_request_id: &'a str,
        payload: &'a str,
        _payload_hash: &'a Felt252,
    ) -> Pin<Box<dyn Future<Output = Result<ProviderResponse, ServerError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(ProviderResponse {
                status_code: 200,
                payload: payload.to_string(),
                response_hash: compute_response_hash(payload.as_bytes()),
                charge_applied: self.fixed_charge,
                policy_reason_code: None,
                policy_evidence_hash: None,
            })
        })
    }
}

/// Provider that proxies the raw request payload to an upstream HTTP service.
pub struct HttpProxyProvider {
    http: reqwest::Client,
    upstream_url: String,
    default_charge: u128,
}

impl HttpProxyProvider {
    pub fn new(
        upstream_url: String,
        timeout: Duration,
        default_charge: u128,
    ) -> Result<Self, ServerError> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| ServerError::Internal(format!("failed to build proxy client: {}", e)))?;
        Ok(Self {
            http,
            upstream_url,
            default_charge,
        })
    }
}

impl ApiProvider for HttpProxyProvider {
    fn execute<'a>(
        &'a self,
        client_request_id: &'a str,
        payload: &'a str,
        payload_hash: &'a Felt252,
    ) -> Pin<Box<dyn Future<Output = Result<ProviderResponse, ServerError>> + Send + 'a>> {
        Box::pin(async move {
            let response = self
                .http
                .post(&self.upstream_url)
                .header("x-client-request-id", client_request_id)
                .header("x-idempotency-key", client_request_id)
                .header("x-zkapi-payload-hash", payload_hash.to_hex())
                .header("content-type", guess_content_type(payload))
                .body(payload.to_owned())
                .send()
                .await
                .map_err(|e| ServerError::Internal(format!("proxy request failed: {}", e)))?;
            let status_code = response.status().as_u16();
            let headers = response.headers().clone();
            let payload = response
                .text()
                .await
                .map_err(|e| ServerError::Internal(format!("proxy response read failed: {}", e)))?;

            Ok(ProviderResponse {
                status_code,
                response_hash: compute_response_hash(payload.as_bytes()),
                payload,
                charge_applied: parse_header_u128(&headers, "x-zkapi-charge-applied")?
                    .unwrap_or(self.default_charge),
                policy_reason_code: parse_header_u32(&headers, "x-zkapi-policy-reason-code")?,
                policy_evidence_hash: parse_header_felt(&headers, "x-zkapi-policy-evidence-hash")?,
            })
        })
    }
}

pub fn build_provider(config: &ServerConfig) -> anyhow::Result<Arc<dyn ApiProvider>> {
    match config.provider_kind {
        ProviderKind::Echo => Ok(Arc::new(EchoProvider::new(config.echo_fixed_charge))),
        ProviderKind::HttpProxy => {
            let upstream_url = config
                .proxy_upstream_url
                .clone()
                .ok_or_else(|| anyhow!("missing proxy_upstream_url for http-proxy provider"))?;
            Ok(Arc::new(HttpProxyProvider::new(
                upstream_url,
                Duration::from_millis(config.proxy_timeout_ms),
                config.proxy_default_charge,
            )?))
        }
    }
}

fn guess_content_type(payload: &str) -> &'static str {
    let trimmed = payload.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        "application/json"
    } else {
        "text/plain; charset=utf-8"
    }
}

fn parse_header_u128(headers: &HeaderMap, name: &str) -> Result<Option<u128>, ServerError> {
    parse_header(headers, name, |value| {
        value
            .parse::<u128>()
            .map_err(|e| format!("invalid {} header: {}", name, e))
    })
}

fn parse_header_u32(headers: &HeaderMap, name: &str) -> Result<Option<u32>, ServerError> {
    parse_header(headers, name, |value| {
        value
            .parse::<u32>()
            .map_err(|e| format!("invalid {} header: {}", name, e))
    })
}

fn parse_header_felt(headers: &HeaderMap, name: &str) -> Result<Option<Felt252>, ServerError> {
    parse_header(headers, name, |value| {
        Felt252::from_hex(value).map_err(|e| format!("invalid {} header: {}", name, e))
    })
}

fn parse_header<T, F>(headers: &HeaderMap, name: &str, parser: F) -> Result<Option<T>, ServerError>
where
    F: FnOnce(&str) -> Result<T, String>,
{
    let Some(value) = headers.get(name) else {
        return Ok(None);
    };
    parse_header_value(name, value)
        .and_then(|value| parser(value).map(Some).map_err(ServerError::Internal))
}

fn parse_header_value<'a>(name: &str, value: &'a HeaderValue) -> Result<&'a str, ServerError> {
    value
        .to_str()
        .map_err(|e| ServerError::Internal(format!("invalid {} header: {}", name, e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::http::StatusCode;
    use axum::routing::post;
    use axum::{body::Bytes, Router};
    use tokio::net::TcpListener;

    async fn start_proxy_server() -> String {
        async fn handler(body: Bytes) -> (StatusCode, [(&'static str, &'static str); 1], String) {
            let body_string = String::from_utf8(body.to_vec()).unwrap();
            (
                StatusCode::CREATED,
                [("x-zkapi-charge-applied", "7")],
                format!("proxy:{body_string}"),
            )
        }

        let app = Router::new().route("/", post(handler));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{}", addr)
    }

    #[tokio::test]
    async fn test_http_proxy_provider_round_trip() {
        let url = start_proxy_server().await;
        let provider = HttpProxyProvider::new(url, Duration::from_secs(5), 3).unwrap();
        let response = provider
            .execute("req-1", "{\"hello\":\"world\"}", &Felt252::from_u64(9))
            .await
            .unwrap();

        assert_eq!(response.status_code, 201);
        assert_eq!(response.payload, "proxy:{\"hello\":\"world\"}");
        assert_eq!(
            response.response_hash,
            compute_response_hash(response.payload.as_bytes())
        );
        assert_eq!(response.charge_applied, 7);
    }

    #[tokio::test]
    async fn test_http_proxy_provider_uses_default_charge_without_header() {
        async fn handler(body: Bytes) -> (StatusCode, String) {
            let body_string = String::from_utf8(body.to_vec()).unwrap();
            (StatusCode::OK, format!("plain:{body_string}"))
        }

        let app = Router::new().route("/", post(handler));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let provider =
            HttpProxyProvider::new(format!("http://{}", addr), Duration::from_secs(5), 11).unwrap();
        let response = provider
            .execute("req-2", "hello", &Felt252::from_u64(10))
            .await
            .unwrap();

        assert_eq!(response.charge_applied, 11);
    }
}
