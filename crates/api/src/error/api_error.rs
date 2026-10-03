//! The error value handlers and layers return.
//!
//! An [`ApiError`] turns into a response with the right status and no body yet: it travels in the
//! response extensions until the rendering middleware writes the JSON body with the request id.
//! This module builds errors; it does not write bodies or logs.

use std::borrow::Cow;

use axum::response::{IntoResponse, Response};

use super::code::ErrorCode;

/// A failed request: a stable code and an English message for debugging.
///
/// For server errors the message is a detail for the logs only; clients get a generic message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ApiError {
    code: ErrorCode,
    message: Cow<'static, str>,
}

impl ApiError {
    /// An error with this code and message.
    pub(crate) fn new(code: ErrorCode, message: impl Into<Cow<'static, str>>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// A server error; `detail` is logged with the request id and never sent to the client.
    pub(crate) fn internal(detail: impl Into<Cow<'static, str>>) -> Self {
        Self::new(ErrorCode::Internal, detail)
    }

    /// The error code.
    pub(crate) fn code(&self) -> ErrorCode {
        self.code
    }

    /// The English message (for a server error: the internal detail).
    pub(crate) fn message(&self) -> &str {
        &self.message
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = self.code.status().into_response();
        response.extensions_mut().insert(self);
        response
    }
}
