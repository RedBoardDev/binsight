//! The JSON body extractor of the API.
//!
//! It behaves like `axum::Json` but rejects a bad body with the API's own error: `invalid_request`
//! for a missing content type or invalid JSON, `payload_too_large` above the body size limit.
//! This module only extracts; the handlers validate the content.

use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;

use super::api_error::ApiError;
use super::code::ErrorCode;

/// A request body parsed as JSON into `T`.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ApiJson<T>(pub(crate) T);

impl<T, S> FromRequest<S> for ApiJson<T>
where
    axum::Json<T>: FromRequest<S, Rejection = JsonRejection>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(request, state).await {
            Ok(axum::Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(rejection_to_error(&rejection)),
        }
    }
}

fn rejection_to_error(rejection: &JsonRejection) -> ApiError {
    if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return ApiError::new(ErrorCode::PayloadTooLarge, "the request body is too large");
    }
    ApiError::new(ErrorCode::InvalidRequest, rejection.body_text())
}
