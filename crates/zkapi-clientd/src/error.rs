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
    #[error("OpenRouter lease pending: {0}")]
    LeasePending(String),
    #[error("upstream error: {0}")]
    Upstream(String),
    #[error("upstream returned {status}: {message}")]
    UpstreamResponse { status: StatusCode, message: String },
    #[error("OA key verification failed: {0}")]
    KeyVerification(String),
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
            Self::PendingRequest | Self::LeasePending(_) => StatusCode::CONFLICT,
            Self::InvalidInput(_) | Self::Serialization(_) => StatusCode::BAD_REQUEST,
            Self::UpstreamResponse { status, .. } => *status,
            Self::Wallet(_) | Self::Indexer(_) | Self::Upstream(_) | Self::KeyVerification(_) => {
                StatusCode::BAD_GATEWAY
            }
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::WalletBusy => "wallet_busy",
            Self::NoActiveNote => "no_active_note",
            Self::InsufficientBalance => "insufficient_balance",
            Self::PendingRequest => "pending_request",
            Self::LeasePending(_) => "lease_pending",
            Self::Upstream(_) | Self::UpstreamResponse { .. } => "upstream_error",
            Self::KeyVerification(_) => "key_verification_failed",
            Self::InvalidInput(_) => "invalid_input",
            Self::Wallet(_) => "wallet_error",
            Self::Indexer(_) => "indexer_error",
            Self::Serialization(_) => "serialization_error",
        }
    }

    pub fn funding_url(&self) -> Option<&'static str> {
        matches!(self, Self::NoActiveNote | Self::InsufficientBalance).then_some("/funding")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_http_status_is_not_disguised_as_bad_gateway() {
        let error = AuthError::UpstreamResponse {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "rate limited".to_string(),
        };
        assert_eq!(error.status_code(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(error.funding_url(), None);
    }
}
