//! OA org client for verifier-backed OpenRouter runtime keys.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;
use zkapi_types::wire::OpenRouterLeaseResponse;

use crate::error::ServerError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OaKeyVerificationEvidence {
    pub verifier_url: String,
    pub station_id: String,
    pub station_recently_attested: bool,
    pub key_valid_till: u64,
    pub station_signature: String,
    pub org_signature: String,
}

#[derive(Clone, Serialize)]
pub struct IssuedOpenRouterLease {
    #[serde(flatten)]
    pub lease: OpenRouterLeaseResponse,
    pub key_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification: Option<OaKeyVerificationEvidence>,
}

#[derive(Debug, Clone)]
pub struct OaOrgCreatedKey {
    pub key: String,
    pub hash: String,
    pub expires_at: u64,
    pub openrouter_api_base: String,
    pub verification: OaKeyVerificationEvidence,
}

pub struct OaOrgProvisioner {
    http: reqwest::Client,
    base_url: String,
    shared_secret: String,
}

#[derive(Deserialize)]
struct OaOrgKeyResponse {
    source: String,
    key: String,
    key_hash: String,
    credit_limit: f64,
    duration_minutes: u64,
    expires_at_unix: u64,
    station_id: String,
    station_recently_attested: bool,
    station_signature: String,
    org_signature: String,
    verifier_url: String,
    openrouter_api_base: String,
}

impl OaOrgProvisioner {
    pub fn new(base_url: String, shared_secret: String) -> Result<Self, ServerError> {
        let parsed = reqwest::Url::parse(&base_url)
            .map_err(|_| ServerError::InvalidRequest("invalid OA org URL".to_string()))?;
        if !is_secure_or_loopback_url(parsed.as_str())
            || parsed.username() != ""
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(ServerError::InvalidRequest(
                "OA org URL must be HTTPS (or explicit loopback HTTP) without credentials, query, or fragment"
                    .to_string(),
            ));
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(35))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| {
                ServerError::Internal(format!("failed to build OA org client: {error}"))
            })?;
        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            shared_secret,
        })
    }

    pub async fn create_key(
        &self,
        client_request_id: &str,
        limit_usd: f64,
        ttl_seconds: u64,
    ) -> Result<OaOrgCreatedKey, ServerError> {
        if ttl_seconds == 0 || !ttl_seconds.is_multiple_of(60) {
            return Err(ServerError::InvalidRequest(
                "OA org lease TTL must be a positive whole number of minutes".to_string(),
            ));
        }
        let duration_minutes = ttl_seconds / 60;
        let response = self
            .http
            .post(format!("{}/api/zkapi/request_key", self.base_url))
            .bearer_auth(&self.shared_secret)
            .json(&json!({
                "client_request_id": client_request_id,
                "credit_limit": limit_usd,
                "duration_minutes": duration_minutes,
            }))
            .send()
            .await
            .map_err(|error| {
                ServerError::Internal(format!("OA org key request failed: {error}"))
            })?;
        let status = response.status();
        let text = response.text().await.map_err(|error| {
            ServerError::Internal(format!("OA org key response failed: {error}"))
        })?;
        if !status.is_success() {
            return Err(ServerError::Internal(format!(
                "OA org key request returned {status}"
            )));
        }
        let response: OaOrgKeyResponse = serde_json::from_str(&text).map_err(|error| {
            ServerError::Internal(format!("invalid OA org key response: {error}"))
        })?;
        validate_response(&response, limit_usd, duration_minutes, ttl_seconds)?;
        Ok(OaOrgCreatedKey {
            key: response.key,
            hash: response.key_hash,
            expires_at: response.expires_at_unix,
            openrouter_api_base: response.openrouter_api_base,
            verification: OaKeyVerificationEvidence {
                verifier_url: response.verifier_url,
                station_id: response.station_id,
                station_recently_attested: response.station_recently_attested,
                key_valid_till: response.expires_at_unix,
                station_signature: response.station_signature,
                org_signature: response.org_signature,
            },
        })
    }
}

fn validate_response(
    response: &OaOrgKeyResponse,
    requested_limit_usd: f64,
    requested_duration_minutes: u64,
    ttl_seconds: u64,
) -> Result<(), ServerError> {
    let now = current_timestamp();
    let limit_matches = response.credit_limit.is_finite()
        && (response.credit_limit - requested_limit_usd).abs()
            <= f64::EPSILON.max(requested_limit_usd * 1e-9);
    let expected_expiry = now.saturating_add(ttl_seconds);
    let expiry_is_bounded = response.expires_at_unix >= expected_expiry.saturating_sub(30)
        && response.expires_at_unix <= expected_expiry.saturating_add(30);
    let verifier_is_secure = is_secure_or_loopback_url(&response.verifier_url);
    let inference_is_secure = is_secure_or_loopback_url(&response.openrouter_api_base);
    let signatures_are_hex =
        is_hex_signature(&response.station_signature) && is_hex_signature(&response.org_signature);
    if response.source != "oa_org"
        || response.key.is_empty()
        || response.key_hash.is_empty()
        || response.station_id.is_empty()
        || response.duration_minutes != requested_duration_minutes
        || !limit_matches
        || !expiry_is_bounded
        || !verifier_is_secure
        || !inference_is_secure
        || !signatures_are_hex
    {
        return Err(ServerError::Internal(
            "OA org returned unusable or unbounded key evidence".to_string(),
        ));
    }
    Ok(())
}

fn is_hex_signature(value: &str) -> bool {
    value.len() == 128 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_secure_or_loopback_url(value: &str) -> bool {
    value.starts_with("https://")
        || value.starts_with("http://127.0.0.1:")
        || value.starts_with("http://localhost:")
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_require_exact_ed25519_hex_encoding() {
        assert!(is_hex_signature(&"ab".repeat(64)));
        assert!(!is_hex_signature(&"ab".repeat(63)));
        assert!(!is_hex_signature(&"zz".repeat(64)));
    }

    #[test]
    fn only_https_or_explicit_loopback_urls_are_accepted() {
        assert!(is_secure_or_loopback_url("https://verifier.example"));
        assert!(is_secure_or_loopback_url("http://127.0.0.1:8080"));
        assert!(!is_secure_or_loopback_url("http://verifier.example"));
    }

    #[test]
    fn org_client_refuses_to_send_a_secret_over_plaintext_http() {
        assert!(
            OaOrgProvisioner::new("http://org.example".to_string(), "secret".to_string()).is_err()
        );
        assert!(
            OaOrgProvisioner::new("http://127.0.0.1:8005".to_string(), "secret".to_string())
                .is_ok()
        );
    }
}
