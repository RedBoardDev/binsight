//! A deadline for producing a response.
//!
//! A request whose response has not started after [`REQUEST_TIMEOUT_SECS`] is answered with a
//! `request_timeout` error. Only the wait for the response head is timed: a live event stream,
//! whose body flows for hours, is not cut. This module only enforces the deadline.

use std::time::Duration;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::{ApiError, ErrorCode};

/// How long a handler may take before the client gets an error.
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// The middleware: runs the rest of the stack with a deadline.
pub(crate) async fn time_out_slow_requests(request: Request, next: Next) -> Response {
    let deadline = Duration::from_secs(REQUEST_TIMEOUT_SECS);
    match tokio::time::timeout(deadline, next.run(request)).await {
        Ok(response) => response,
        Err(_elapsed) => ApiError::new(
            ErrorCode::RequestTimeout,
            "the server did not answer in time",
        )
        .into_response(),
    }
}
