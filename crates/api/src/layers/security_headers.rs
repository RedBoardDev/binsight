//! The security headers sent with every response.
//!
//! They tell browsers to load scripts, styles and data only from this server, never to guess a
//! content type, never to show the app inside a frame of another site, and to keep the referrer
//! on this site. A header a handler already set is left as is. This module only sets headers.

use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;

/// Where the web app may load things from: only from this server. Inline styles are allowed
/// because the UI library sets `style` attributes; inline scripts are not.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; \
    style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; \
    font-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; \
    base-uri 'self'; form-action 'self'";

/// Every security header and its value.
const SECURITY_HEADERS: [(HeaderName, &str); 4] = [
    (header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY),
    (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
    (header::X_FRAME_OPTIONS, "DENY"),
    (header::REFERRER_POLICY, "same-origin"),
];

/// The middleware: adds each security header the response does not have yet.
pub(crate) async fn add_security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    for (name, value) in SECURITY_HEADERS {
        if !headers.contains_key(&name) {
            headers.insert(name, HeaderValue::from_static(value));
        }
    }
    response
}
