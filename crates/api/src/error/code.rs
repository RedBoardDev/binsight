//! The stable error codes of the API and their HTTP statuses.
//!
//! A code is part of the contract: clients translate it, so a code is never renamed or reused for
//! another meaning. This module lists the codes; it does not build responses.

use axum::http::StatusCode;
use serde::Serialize;
use utoipa::ToSchema;

/// Why a request failed. Stable: clients use it as their translation key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ErrorCode {
    /// The request body is not what the route expects (missing JSON content type, invalid JSON,
    /// missing field).
    InvalidRequest,
    /// The route needs a session and there is none (or it expired): sign in.
    Unauthenticated,
    /// The password is wrong.
    InvalidCredentials,
    /// A state-changing request came from another site and was refused.
    ForbiddenCrossOrigin,
    /// There is no API route at this path.
    NotFound,
    /// The route exists but not for this HTTP method.
    MethodNotAllowed,
    /// The request names a wallet that is not tracked.
    WalletNotFound,
    /// The request names a position no tracked wallet holds or held (its wallet may have been
    /// removed).
    PositionNotFound,
    /// The server took too long to answer (`503`: the request itself arrived in time, so clients
    /// and proxies must not treat it as a `408` they may replay on their own).
    RequestTimeout,
    /// A page cursor cannot be read or belongs to another query: start again from the first
    /// page.
    InvalidCursor,
    /// The request body is larger than the server accepts.
    PayloadTooLarge,
    /// Too many failed logins; the `Retry-After` header says how long to wait.
    TooManyAttempts,
    /// The engine does not serve figures yet (it is still being built); in demo mode every
    /// figure is available.
    DataNotReady,
    /// Something failed on the server; the logs have the details under the request id.
    Internal,
}

impl ErrorCode {
    /// The HTTP status that goes with the code.
    pub(crate) fn status(self) -> StatusCode {
        match self {
            Self::InvalidRequest | Self::InvalidCursor => StatusCode::BAD_REQUEST,
            Self::Unauthenticated | Self::InvalidCredentials => StatusCode::UNAUTHORIZED,
            Self::ForbiddenCrossOrigin => StatusCode::FORBIDDEN,
            Self::NotFound | Self::WalletNotFound | Self::PositionNotFound => StatusCode::NOT_FOUND,
            Self::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            Self::RequestTimeout | Self::DataNotReady => StatusCode::SERVICE_UNAVAILABLE,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::TooManyAttempts => StatusCode::TOO_MANY_REQUESTS,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_codes_in_snake_case() {
        let json = serde_json::to_string(&ErrorCode::MethodNotAllowed).unwrap();
        assert_eq!(json, "\"method_not_allowed\"");
    }

    #[test]
    fn maps_only_server_side_failures_to_server_errors() {
        for code in [ErrorCode::NotFound, ErrorCode::MethodNotAllowed] {
            assert!(code.status().is_client_error(), "{code:?}");
        }
        for code in [ErrorCode::RequestTimeout, ErrorCode::Internal] {
            assert!(code.status().is_server_error(), "{code:?}");
        }
    }
}
