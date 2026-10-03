//! `POST /api/v1/auth/login`, `POST /api/v1/auth/logout` and `GET /api/v1/auth/session`.
//!
//! Login checks the throttle first, then the password, and answers with the session cookie.
//! Logout is public and idempotent: it always deletes the cookie. Reading the session is a
//! protected route, so it only runs behind the session guard. This module holds the handlers and
//! their wire types.

use axum::Json;
use axum::extract::{Extension, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum_extra::extract::SignedCookieJar;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::session::{Session, with_session_cookie, without_session_cookie};
use super::throttle::RetryAfter;
use crate::error::{ApiError, ApiJson, ErrorBody, ErrorCode};
use crate::state::AppState;

/// A login attempt. Deliberately not `Debug`: it holds the password.
#[derive(Deserialize, ToSchema)]
pub(crate) struct LoginRequest {
    /// The owner's password.
    #[schema(format = Password)]
    pub(crate) password: String,
}

/// The current session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct SessionInfo {
    /// Always `true`: without a session the API answers `401` instead.
    pub(crate) authenticated: bool,
    /// When the session ends (RFC 3339, UTC); the owner must then sign in again.
    pub(crate) expires_at: Timestamp,
}

impl From<Session> for SessionInfo {
    fn from(session: Session) -> Self {
        Self {
            authenticated: true,
            expires_at: session.expires_at,
        }
    }
}

/// Signs the owner in with the password and sets the session cookie.
#[utoipa::path(
    post,
    path = "/api/v1/auth/login",
    operation_id = "login",
    tag = "auth",
    request_body = LoginRequest,
    responses(
        (status = 200, description = "Signed in; the session cookie is set.", body = SessionInfo),
        (status = 400, description = "The body is not a valid login request.", body = ErrorBody),
        (status = 401, description = "The password is wrong (`invalid_credentials`).", body = ErrorBody),
        (status = 403, description = "A cross-site request (`forbidden_cross_origin`).", body = ErrorBody),
        (status = 429, description = "Too many failed attempts (`too_many_attempts`); retry after the delay.",
            body = ErrorBody,
            headers(("retry-after" = u32, description = "Seconds to wait before the next attempt."))),
    ),
)]
pub(crate) async fn login(
    State(state): State<AppState>,
    jar: SignedCookieJar,
    ApiJson(attempt): ApiJson<LoginRequest>,
) -> Response {
    let now = state.clock.now();
    if let Err(RetryAfter(seconds)) = state.auth.throttle.check(now) {
        let error = ApiError::new(
            ErrorCode::TooManyAttempts,
            "too many failed attempts; wait before trying again",
        );
        return ([(header::RETRY_AFTER, seconds.to_string())], error).into_response();
    }
    if !state.auth.password.matches(&attempt.password) {
        state.auth.throttle.record_failure(now);
        return ApiError::new(ErrorCode::InvalidCredentials, "the password is incorrect")
            .into_response();
    }
    state.auth.throttle.record_success();
    let Some(session) = Session::start(now) else {
        return ApiError::internal("the clock is out of the representable range").into_response();
    };
    let jar = with_session_cookie(jar, session, state.auth.is_cookie_secure);
    (jar, Json(SessionInfo::from(session))).into_response()
}

/// Signs out: deletes the session cookie. Always succeeds, signed in or not.
#[utoipa::path(
    post,
    path = "/api/v1/auth/logout",
    operation_id = "logout",
    tag = "auth",
    responses(
        (status = 204, description = "Signed out; the session cookie is deleted."),
        (status = 403, description = "A cross-site request (`forbidden_cross_origin`).", body = ErrorBody),
    ),
)]
pub(crate) async fn logout(jar: SignedCookieJar) -> (StatusCode, SignedCookieJar) {
    (StatusCode::NO_CONTENT, without_session_cookie(jar))
}

/// The current session, if the session cookie is valid.
#[utoipa::path(
    get,
    path = "/api/v1/auth/session",
    operation_id = "getSession",
    tag = "auth",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Signed in.", body = SessionInfo),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
    ),
)]
pub(crate) async fn get_session(Extension(session): Extension<Session>) -> Json<SessionInfo> {
    Json(SessionInfo::from(session))
}
