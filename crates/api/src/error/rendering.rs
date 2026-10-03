//! Writes the JSON body of every error response, with the request id.
//!
//! This middleware sits outside the routes and the layers that can fail (panics, timeouts, CSRF):
//! whenever a response carries an [`ApiError`], it replaces the empty body with an [`ErrorBody`].
//! Server errors are logged here, with their internal detail and the request id, and the client
//! only gets a generic message. Responses without an [`ApiError`] pass through untouched.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;
use serde::Serialize;
use tracing::error;
use utoipa::ToSchema;

use super::api_error::ApiError;
use super::code::ErrorCode;

/// The header that carries the request id, set on every request and response.
pub(crate) const REQUEST_ID_HEADER: &str = "x-request-id";

/// What a client sees instead of the detail of a server error.
const INTERNAL_ERROR_MESSAGE: &str =
    "the server failed to handle the request; its logs have the details under this request id";

/// The body of every error response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ErrorBody {
    /// What went wrong.
    pub(crate) error: ErrorDetail,
}

/// The content of an error body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ErrorDetail {
    /// The stable error code; clients translate it.
    pub(crate) code: ErrorCode,
    /// An English explanation for debugging; never shown to users as is.
    pub(crate) message: String,
    /// The id of the request, also in the `x-request-id` response header.
    pub(crate) request_id: String,
}

/// The middleware: renders the body of responses that carry an [`ApiError`].
pub(crate) async fn render_error_bodies(request: Request, next: Next) -> Response {
    let request_id = request
        .headers()
        .get(REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let response = next.run(request).await;
    let Some(api_error) = response.extensions().get::<ApiError>().cloned() else {
        return response;
    };
    let message = public_message(&api_error, &request_id);
    let body = ErrorBody {
        error: ErrorDetail {
            code: api_error.code(),
            message,
            request_id,
        },
    };
    with_json_body(response, &body)
}

/// The message sent to the client. A server error is logged and replaced by a generic message.
fn public_message(api_error: &ApiError, request_id: &str) -> String {
    if api_error.code().status().is_server_error() {
        error!(request_id, code = ?api_error.code(), detail = api_error.message(), "request failed");
        return INTERNAL_ERROR_MESSAGE.to_owned();
    }
    api_error.message().to_owned()
}

/// Keeps the status and headers of `response` (for example `Retry-After`) and sets a JSON body.
fn with_json_body(response: Response, body: &ErrorBody) -> Response {
    let (mut parts, _) = response.into_parts();
    let Ok(json) = serde_json::to_vec(body) else {
        // Serializing plain strings and an enum cannot fail; keep the status if it ever does.
        return Response::from_parts(parts, Body::empty());
    };
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Response::from_parts(parts, Body::from(json))
}
