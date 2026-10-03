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
    /// There is no API route at this path.
    NotFound,
    /// The route exists but not for this HTTP method.
    MethodNotAllowed,
    /// The server took too long to answer.
    RequestTimeout,
    /// Something failed on the server; the logs have the details under the request id.
    Internal,
}

impl ErrorCode {
    /// The HTTP status that goes with the code.
    pub(crate) fn status(self) -> StatusCode {
        match self {
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            Self::RequestTimeout => StatusCode::REQUEST_TIMEOUT,
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
    fn maps_only_internal_failures_to_server_errors() {
        for code in [
            ErrorCode::NotFound,
            ErrorCode::MethodNotAllowed,
            ErrorCode::RequestTimeout,
        ] {
            assert!(code.status().is_client_error(), "{code:?}");
        }
        assert!(ErrorCode::Internal.status().is_server_error());
    }
}
