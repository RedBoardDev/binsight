//! The guard in front of every protected route.
//!
//! It is applied to the whole protected router, so a new route added there is protected without
//! anyone having to remember it. A request without a valid session gets `401 unauthenticated`;
//! a valid one reaches the handler with its [`Session`] in the request extensions. This module
//! only checks; it never issues a session.

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::SignedCookieJar;

use super::session::read_session;
use crate::app::AppState;
use crate::error::{ApiError, ErrorCode};

/// The middleware: lets the request through only with a valid session cookie.
pub(crate) async fn require_session(
    State(state): State<AppState>,
    jar: SignedCookieJar,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(session) = read_session(&jar, state.clock.now()) else {
        return ApiError::new(
            ErrorCode::Unauthenticated,
            "there is no valid session; sign in first",
        )
        .into_response();
    };
    request.extensions_mut().insert(session);
    next.run(request).await
}
