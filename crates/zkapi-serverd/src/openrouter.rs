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

    /// Create a credit-limited ephemeral runtime key.
    pub async fn create_key(&self, name: &str, limit_usd: f64) -> Result<CreatedKey, ServerError> {
        let body = serde_json::json!({ "name": name, "limit": limit_usd });
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
