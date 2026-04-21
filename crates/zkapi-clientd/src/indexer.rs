use serde::Deserialize;
use zkapi_types::Felt252;

use crate::error::AuthError;

#[derive(Debug, Clone)]
pub struct IndexerClient {
    base_url: String,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct TreeRootResponse {
    root: Felt252,
}

#[derive(Debug, Deserialize)]
struct TreePathResponse {
    siblings: Vec<Felt252>,
}

#[derive(Debug, Deserialize)]
struct NextNoteIdResponse {
    next_note_id: u32,
}

impl IndexerClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
        }
    }

    pub async fn root(&self) -> Result<Felt252, AuthError> {
        let url = format!("{}/v1/tree/root", self.base_url);
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|err| AuthError::Indexer(err.to_string()))?;
        let response = response
            .error_for_status()
            .map_err(|err| AuthError::Indexer(err.to_string()))?;
        let payload: TreeRootResponse = response
            .json()
            .await
            .map_err(|err| AuthError::Indexer(err.to_string()))?;
        Ok(payload.root)
    }

    pub async fn next_note_id(&self) -> Result<u32, AuthError> {
        let url = format!("{}/v1/tree/next-note-id", self.base_url);
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|err| AuthError::Indexer(err.to_string()))?;
        let response = response
            .error_for_status()
            .map_err(|err| AuthError::Indexer(err.to_string()))?;
        let payload: NextNoteIdResponse = response
            .json()
            .await
            .map_err(|err| AuthError::Indexer(err.to_string()))?;
        Ok(payload.next_note_id)
    }

    pub async fn note_path(&self, note_id: u32) -> Result<Vec<Felt252>, AuthError> {
        self.path(format!("{}/v1/tree/notes/{note_id}/path", self.base_url))
            .await
    }

    pub async fn zero_path(&self, note_id: u32) -> Result<Vec<Felt252>, AuthError> {
        self.path(format!(
            "{}/v1/tree/notes/{note_id}/zero-path",
            self.base_url
        ))
        .await
    }

    async fn path(&self, url: String) -> Result<Vec<Felt252>, AuthError> {
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|err| AuthError::Indexer(err.to_string()))?;
        let response = response
            .error_for_status()
            .map_err(|err| AuthError::Indexer(err.to_string()))?;
        let payload: TreePathResponse = response
            .json()
            .await
            .map_err(|err| AuthError::Indexer(err.to_string()))?;
        Ok(payload.siblings)
    }
}
