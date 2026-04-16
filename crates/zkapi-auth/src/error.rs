use axum::http::StatusCode;
use thiserror::Error;
use zkapi_client::error::ClientError;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("wallet is busy in another process")]
    WalletBusy,
    #[error("wallet has no active note; fund it first")]
    NoActiveNote,
    #[error("wallet balance is too low for this request")]
    InsufficientBalance,
    #[error("wallet has a pending request; recover it before spending again")]
    PendingRequest,
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("wallet error: {0}")]
    Wallet(String),
    #[error("indexer error: {0}")]
    Indexer(String),
    #[error("serialization error: {0}")]
    Serialization(String),
}

impl AuthError {
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::WalletBusy => StatusCode::CONFLICT,
            Self::NoActiveNote | Self::InsufficientBalance => StatusCode::PAYMENT_REQUIRED,
            Self::PendingRequest => StatusCode::CONFLICT,
            Self::InvalidInput(_) | Self::Serialization(_) => StatusCode::BAD_REQUEST,
            Self::Wallet(_) | Self::Indexer(_) => StatusCode::BAD_GATEWAY,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::WalletBusy => "wallet_busy",
            Self::NoActiveNote => "no_active_note",
            Self::InsufficientBalance => "insufficient_balance",
            Self::PendingRequest => "pending_request",
            Self::InvalidInput(_) => "invalid_input",
            Self::Wallet(_) => "wallet_error",
            Self::Indexer(_) => "indexer_error",
            Self::Serialization(_) => "serialization_error",
        }
    }
}

impl From<ClientError> for AuthError {
    fn from(value: ClientError) -> Self {
        match value {
            ClientError::NoActiveNote => Self::NoActiveNote,
            ClientError::InsufficientBalance { .. } => Self::InsufficientBalance,
            ClientError::PendingRequest => Self::PendingRequest,
            other => Self::Wallet(other.to_string()),
        }
    }
}
