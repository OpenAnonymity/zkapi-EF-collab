//! Server error types.

use thiserror::Error;

/// Errors that can occur during server-side request processing.
#[derive(Error, Debug)]
pub enum ServerError {
    #[error("invalid proof: {0}")]
    InvalidProof(String),

    #[error("stale root: latest is {latest_root}")]
    StaleRoot { latest_root: String },

    #[error("replayed nullifier")]
    Replay,

    #[error("note expired")]
    NoteExpired,

    #[error("internal error: {0}")]
    Internal(String),

    #[error("capacity exhausted")]
    CapacityExhausted,

    #[error("nullifier already used")]
    NullifierUsed,

    #[error("database error: {0}")]
    Database(String),

    #[error("invalid request: {0}")]
    InvalidRequest(String),

    #[error("protocol mismatch: {0}")]
    ProtocolMismatch(String),
}

impl ServerError {
    /// Return a machine-readable error code string for the error.
    pub fn error_code(&self) -> &str {
        match self {
            ServerError::InvalidProof(_) => "invalid_proof",
            ServerError::StaleRoot { .. } => "stale_root",
            ServerError::Replay => "replay",
            ServerError::NoteExpired => "note_expired",
            ServerError::Internal(_) => "internal_error",
            ServerError::CapacityExhausted => "capacity_exhausted",
            ServerError::NullifierUsed => "nullifier_used",
            ServerError::Database(_) => "database_error",
            ServerError::InvalidRequest(_) => "invalid_request",
            ServerError::ProtocolMismatch(_) => "protocol_mismatch",
        }
    }

    /// Whether the client should retry the request.
    pub fn is_retriable(&self) -> bool {
        match self {
            ServerError::StaleRoot { .. } => true,
            ServerError::Internal(_) => true,
            ServerError::Database(_) => true,
            ServerError::InvalidProof(_) => false,
            ServerError::Replay => false,
            ServerError::NoteExpired => false,
            ServerError::CapacityExhausted => false,
            ServerError::NullifierUsed => false,
            ServerError::InvalidRequest(_) => false,
            ServerError::ProtocolMismatch(_) => false,
        }
    }
}
