//! OpenRouter provisioning API client.
//!
//! Used by the metered provider's "ephemeral key" billing mode (Mode 2): the
//! server holds a provisioning/management key and mints short-lived, credit-
//! limited runtime keys that the browser uses to talk to OpenRouter directly.
//! Because the server issues the key it can also read that key's authoritative
//! aggregate USD usage for settlement/audit, and revoke it.
//!
//! Endpoints (base `https://openrouter.ai/api/v1`):
//!   * `POST   /keys`         create a runtime key  -> `{ key, data:{hash,limit,..} }`
//!   * `GET    /keys/{hash}`  read a key            -> `{ data:{usage,limit,..} }`
//!   * `DELETE /keys/{hash}`  revoke a key
//!
//! Verified live against the provided management key during development.

use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::error::ServerError;

/// A freshly-created ephemeral OpenRouter key.
#[derive(Debug, Clone)]
pub struct CreatedKey {
    /// The secret runtime key (`sk-or-v1-...`). Returned exactly once.
    pub key: String,
    /// Stable hash id used to read usage / revoke the key later.
    pub hash: String,
    /// The credit limit (USD) the key was created with, if any.
    pub limit_usd: Option<f64>,
    /// The expiry (ISO 8601) the key was created with, if any.
    pub expires_at: Option<String>,
}

/// Format a UNIX timestamp (seconds) as an ISO-8601 UTC string
/// (`YYYY-MM-DDTHH:MM:SSZ`) — the format OpenRouter's `expires_at` accepts.
/// Self-contained (no date crate) via the civil-from-days algorithm.
pub fn unix_to_iso8601(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, min, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Howard Hinnant's civil_from_days (days since 1970-01-01).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}Z")
}

/// Authoritative usage/limit snapshot for a key.
#[derive(Debug, Clone, Default)]
pub struct KeyUsage {
    pub hash: String,
    pub usage_usd: f64,
    pub limit_usd: Option<f64>,
    pub limit_remaining_usd: Option<f64>,
    pub disabled: bool,
}

/// Thin client over the OpenRouter provisioning API.
pub struct OpenRouterProvisioner {
    http: reqwest::Client,
    provisioning_key: String,
    base: String,
}

#[derive(Deserialize)]
struct CreateKeyEnvelope {
    key: String,
    data: KeyData,
}

#[derive(Deserialize)]
struct GetKeyEnvelope {
    data: KeyData,
}

#[derive(Deserialize, Default)]
struct KeyData {
    #[serde(default)]
    hash: String,
    #[serde(default)]
    limit: Option<f64>,
    #[serde(default)]
    limit_remaining: Option<f64>,
    #[serde(default)]
    usage: f64,
    #[serde(default)]
    disabled: bool,
    #[serde(default)]
    expires_at: Option<String>,
}

impl OpenRouterProvisioner {
    pub fn new(provisioning_key: String, base: String, timeout: Duration) -> Result<Self, ServerError> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| ServerError::Internal(format!("failed to build provisioner client: {e}")))?;
        Ok(Self {
            http,
            provisioning_key,
            base: base.trim_end_matches('/').to_string(),
        })
    }

    fn keys_url(&self) -> String {
        format!("{}/v1/keys", self.base)
    }

    fn key_url(&self, hash: &str) -> String {
        format!("{}/v1/keys/{}", self.base, hash)
    }

    /// Create a credit-limited runtime key, optionally with an ISO-8601 expiry.
    pub async fn create_key(
        &self,
        name: &str,
        limit_usd: f64,
        expires_at_iso: Option<&str>,
    ) -> Result<CreatedKey, ServerError> {
        let mut body = serde_json::json!({ "name": name, "limit": limit_usd });
        if let (Some(exp), Value::Object(map)) = (expires_at_iso, &mut body) {
            map.insert("expires_at".to_string(), Value::String(exp.to_string()));
        }
        let resp = self
            .http
            .post(self.keys_url())
            .bearer_auth(&self.provisioning_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| ServerError::Internal(format!("openrouter create_key failed: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| ServerError::Internal(format!("openrouter create_key read failed: {e}")))?;
        if !status.is_success() {
            return Err(ServerError::Internal(format!(
                "openrouter create_key returned {status}: {}",
                truncate(&text, 300)
            )));
        }
        let env: CreateKeyEnvelope = serde_json::from_str(&text)
            .map_err(|e| ServerError::Internal(format!("openrouter create_key parse failed: {e}")))?;
        Ok(CreatedKey {
            key: env.key,
            hash: env.data.hash,
            limit_usd: env.data.limit,
            expires_at: env.data.expires_at,
        })
    }

    /// Read a key's authoritative aggregate usage/limit.
    pub async fn get_key_usage(&self, hash: &str) -> Result<KeyUsage, ServerError> {
        let resp = self
            .http
            .get(self.key_url(hash))
            .bearer_auth(&self.provisioning_key)
            .send()
            .await
            .map_err(|e| ServerError::Internal(format!("openrouter get_key failed: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| ServerError::Internal(format!("openrouter get_key read failed: {e}")))?;
        if !status.is_success() {
            return Err(ServerError::Internal(format!(
                "openrouter get_key returned {status}: {}",
                truncate(&text, 300)
            )));
        }
        let env: GetKeyEnvelope = serde_json::from_str(&text)
            .map_err(|e| ServerError::Internal(format!("openrouter get_key parse failed: {e}")))?;
        Ok(KeyUsage {
            hash: if env.data.hash.is_empty() {
                hash.to_string()
            } else {
                env.data.hash
            },
            usage_usd: env.data.usage,
            limit_usd: env.data.limit,
            limit_remaining_usd: env.data.limit_remaining,
            disabled: env.data.disabled,
        })
    }

    /// Revoke an ephemeral key. Best-effort; logs rather than failing hard.
    pub async fn delete_key(&self, hash: &str) -> Result<(), ServerError> {
        let resp = self
            .http
            .delete(self.key_url(hash))
            .bearer_auth(&self.provisioning_key)
            .send()
            .await
            .map_err(|e| ServerError::Internal(format!("openrouter delete_key failed: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(ServerError::Internal(format!(
                "openrouter delete_key returned {status}: {}",
                truncate(&text, 200)
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_formats_known_timestamps() {
        // `date -u -d @1700000000` => Tue Nov 14 22:13:20 UTC 2023
        assert_eq!(unix_to_iso8601(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(unix_to_iso8601(0), "1970-01-01T00:00:00Z");
        // A leap-day check: 2024-02-29.
        assert_eq!(unix_to_iso8601(1_709_208_000), "2024-02-29T12:00:00Z");
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    // Truncate on a char boundary so an upstream error body with multibyte
    // characters never panics.
    let end = s
        .char_indices()
        .take_while(|&(idx, _)| idx <= n)
        .last()
        .map(|(idx, _)| idx)
        .unwrap_or(0);
    format!("{}…", &s[..end])
}
