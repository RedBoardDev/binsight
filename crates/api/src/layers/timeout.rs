//! A deadline for producing a response.
//!
//! A request whose response has not started after [`REQUEST_TIMEOUT_SECS`] is answered with a
//! `request_timeout` error, status `503`: the server was slow, not the client (a `408` would tell
//! some clients and proxies to send the request again on their own). Only the wait for the
//! response head is timed: a live event stream, whose body flows for hours, is not cut. This
//! module only enforces the deadline.

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

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::middleware::from_fn;
    use axum::routing::get;
    use tower::ServiceExt;

    use super::*;

    async fn slow_handler() -> &'static str {
        tokio::time::sleep(Duration::from_secs(REQUEST_TIMEOUT_SECS + 1)).await;
        "too late"
    }

    #[tokio::test(start_paused = true)]
    async fn answers_a_slow_handler_with_a_server_error() {
        let router = Router::new()
            .route("/slow", get(slow_handler))
            .layer(from_fn(time_out_slow_requests));

        let response = router
            .oneshot(Request::get("/slow").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
