//! The middleware stack every request goes through, in one place and in order.
//!
//! Read [`apply`] from top to bottom: that is the order a request goes through the layers (and a
//! response goes back up). This module only assembles them; each custom layer lives in its own
//! file.

mod security_headers;

pub(crate) use security_headers::Transport;
mod timeout;

use std::any::Any;

use axum::Router;
use axum::extract::{DefaultBodyLimit, Request};
use axum::http::header;
use axum::middleware::{from_fn, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use tower::ServiceBuilder;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::compression::CompressionLayer;
use tower_http::csrf::{CsrfLayer, ProtectionError};
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::sensitive_headers::SetSensitiveHeadersLayer;
use tower_http::trace::{DefaultOnRequest, DefaultOnResponse, TraceLayer};
use tracing::{Level, Span, info_span};

use crate::error::{ApiError, ErrorCode, render_error_bodies};

/// The largest request body accepted; a login request is a few dozen bytes.
const MAX_BODY_BYTES: usize = 64 * 1024;

/// Wraps every route of `router` (and its fallbacks) in the middleware stack.
///
/// `cross_site_protection` refuses state-changing requests sent by another site; it is configured
/// with the trusted public URL, if any. `transport` says whether browsers come over HTTPS.
pub(crate) fn apply(
    router: Router,
    cross_site_protection: CsrfLayer,
    transport: Transport,
) -> Router {
    router.layer(
        ServiceBuilder::new()
            // Cookies and credentials never appear in logs.
            .layer(SetSensitiveHeadersLayer::new([
                header::AUTHORIZATION,
                header::COOKIE,
                header::SET_COOKIE,
            ]))
            // Every request gets an id (or keeps the one a proxy gave it)...
            .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
            // ...that appears in its log span...
            .layer(
                TraceLayer::new_for_http()
                    .make_span_with(request_span)
                    .on_request(DefaultOnRequest::new().level(Level::DEBUG))
                    .on_response(DefaultOnResponse::new().level(Level::DEBUG)),
            )
            // ...and is sent back in the response.
            .layer(PropagateRequestIdLayer::x_request_id())
            .layer(from_fn_with_state(
                transport,
                security_headers::add_security_headers,
            ))
            // Live event streams are never compressed (the default predicate excludes them).
            .layer(CompressionLayer::new())
            // Everything below may fail with an `ApiError`; its JSON body is written here.
            .layer(from_fn(render_error_bodies))
            .layer(CatchPanicLayer::custom(respond_to_panic))
            .layer(from_fn(timeout::time_out_slow_requests))
            // A browser cannot be tricked into changing state from another site.
            .layer(cross_site_protection.with_rejection_response(refuse_cross_site_request))
            .layer(DefaultBodyLimit::max(MAX_BODY_BYTES)),
    )
}

/// The log span of a request: method, path and request id (never the query string).
fn request_span(request: &Request) -> Span {
    let request_id = request
        .headers()
        .get(crate::error::REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    info_span!(
        "request",
        method = %request.method(),
        path = %request.uri().path(),
        request_id,
    )
}

/// A state-changing request came from another site.
fn refuse_cross_site_request(_error: ProtectionError) -> Response {
    ApiError::new(
        ErrorCode::ForbiddenCrossOrigin,
        "cross-site requests may not change anything",
    )
    .into_response()
}

/// A handler panicked: answer with a server error instead of dropping the connection.
fn respond_to_panic(_panic: Box<dyn Any + Send + 'static>) -> Response {
    ApiError::internal("a request handler panicked").into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    async fn panicking_handler() -> &'static str {
        panic!("boom")
    }

    #[tokio::test]
    async fn answers_a_panicking_handler_with_a_generic_json_500() {
        let router = apply(
            Router::new().route("/boom", get(panicking_handler)),
            CsrfLayer::new(),
            Transport::Http,
        );

        let response = router
            .oneshot(Request::get("/boom").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"]["code"], "internal");
        assert!(!json["error"]["message"].as_str().unwrap().contains("boom"));
    }
}
