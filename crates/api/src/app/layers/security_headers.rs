//! The security headers sent with every response.
//!
//! They tell browsers to load scripts, styles and data only from this server, never to guess a
//! content type, never to show the app inside a frame of another site, to keep the referrer on
//! this site, to keep the app's window apart from windows of other sites, and to refuse it the
//! camera, the microphone, the location and payments. Behind HTTPS they also tell browsers to
//! use HTTPS only (HSTS). A header a handler already set is left as is. This module only sets
//! headers.

use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;

/// Where the web app may load things from: only from this server. Inline styles are allowed
/// because the UI library sets `style` attributes; inline scripts are not.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; \
    style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; \
    font-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; \
    base-uri 'self'; form-action 'self'";

/// The browser features the app never uses.
const PERMISSIONS_POLICY: &str = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

/// HTTPS only, for a year; sibling subdomains are not ours to decide for.
const STRICT_TRANSPORT_SECURITY: &str = "max-age=31536000";

/// Every security header and its value.
const SECURITY_HEADERS: [(HeaderName, &str); 6] = [
    (header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY),
    (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
    (header::X_FRAME_OPTIONS, "DENY"),
    (header::REFERRER_POLICY, "same-origin"),
    (CROSS_ORIGIN_OPENER_POLICY, "same-origin"),
    (PERMISSIONS_POLICY_HEADER, PERMISSIONS_POLICY),
];

const CROSS_ORIGIN_OPENER_POLICY: HeaderName =
    HeaderName::from_static("cross-origin-opener-policy");
const PERMISSIONS_POLICY_HEADER: HeaderName = HeaderName::from_static("permissions-policy");

/// How browsers reach binsight, which decides whether HSTS is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Transport {
    /// Plain HTTP (on this machine or a private network): HSTS would lock browsers out.
    Http,
    /// HTTPS, through the configured public URL.
    Https,
}

/// The middleware: adds each security header the response does not have yet.
pub(crate) async fn add_security_headers(
    State(transport): State<Transport>,
    request: Request,
    next: Next,
) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    let hsts = (transport == Transport::Https)
        .then_some((header::STRICT_TRANSPORT_SECURITY, STRICT_TRANSPORT_SECURITY));
    for (name, value) in SECURITY_HEADERS.into_iter().chain(hsts) {
        if !headers.contains_key(&name) {
            headers.insert(name, HeaderValue::from_static(value));
        }
    }
    response
}
