//! The session cookie: what it contains and how it is issued, read and removed.
//!
//! The cookie value is `v1.<issued at>.<expires at>` (Unix seconds), signed with HMAC by the
//! cookie jar: a modified or foreign cookie fails the signature and is ignored. A session lasts
//! [`SESSION_LIFETIME_DAYS`] days from login, without sliding renewal. The cookie is `HttpOnly`
//! (scripts cannot read it), `SameSite=Lax`, and `Secure` behind HTTPS. Nothing is stored on the
//! server. This module handles the cookie; deciding who may log in is elsewhere.

use axum_extra::extract::SignedCookieJar;
use axum_extra::extract::cookie::{Cookie, SameSite};
use jiff::{SignedDuration, Timestamp};

/// The name of the session cookie.
pub const SESSION_COOKIE_NAME: &str = "binsight_session";

/// How long a session lasts after login.
const SESSION_LIFETIME_DAYS: i64 = 30;

/// The format marker at the start of the cookie value, so the format can evolve.
const FORMAT_VERSION: &str = "v1";

/// A signed-in session, as read from (or written to) the cookie.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Session {
    /// When the owner logged in.
    pub(crate) issued_at: Timestamp,
    /// When the session ends.
    pub(crate) expires_at: Timestamp,
}

impl Session {
    /// A session starting at `now`, to the second. `None` only if `now` is at the very end of the
    /// representable time range.
    pub(crate) fn start(now: Timestamp) -> Option<Self> {
        let issued_at = Timestamp::from_second(now.as_second()).ok()?;
        let lifetime = SignedDuration::from_hours(SESSION_LIFETIME_DAYS.checked_mul(24)?);
        let expires_at = issued_at.checked_add(lifetime).ok()?;
        Some(Self {
            issued_at,
            expires_at,
        })
    }

    /// Whether the session is still valid at `now`.
    pub(crate) fn is_valid_at(&self, now: Timestamp) -> bool {
        now < self.expires_at
    }

    fn to_cookie_value(self) -> String {
        format!(
            "{FORMAT_VERSION}.{}.{}",
            self.issued_at.as_second(),
            self.expires_at.as_second()
        )
    }

    fn from_cookie_value(value: &str) -> Option<Self> {
        let mut parts = value.split('.');
        let (Some(FORMAT_VERSION), Some(issued), Some(expires), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        Some(Self {
            issued_at: Timestamp::from_second(issued.parse().ok()?).ok()?,
            expires_at: Timestamp::from_second(expires.parse().ok()?).ok()?,
        })
    }
}

/// Adds the cookie of `session` to the jar (it is signed when the jar becomes a response).
pub(crate) fn with_session_cookie(
    jar: SignedCookieJar,
    session: Session,
    is_secure: bool,
) -> SignedCookieJar {
    let max_age = session
        .expires_at
        .as_second()
        .saturating_sub(session.issued_at.as_second());
    let cookie = Cookie::build((SESSION_COOKIE_NAME, session.to_cookie_value()))
        .http_only(true)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(cookie::time::Duration::seconds(max_age))
        .secure(is_secure)
        .build();
    jar.add(cookie)
}

/// Tells the browser to delete the session cookie.
pub(crate) fn without_session_cookie(jar: SignedCookieJar) -> SignedCookieJar {
    jar.remove(Cookie::build(SESSION_COOKIE_NAME).path("/"))
}

/// The session in the jar, if its signature is valid and it has not expired at `now`.
pub(crate) fn read_session(jar: &SignedCookieJar, now: Timestamp) -> Option<Session> {
    let cookie = jar.get(SESSION_COOKIE_NAME)?;
    let session = Session::from_cookie_value(cookie.value())?;
    session.is_valid_at(now).then_some(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> Timestamp {
        Timestamp::from_second(seconds).unwrap()
    }

    #[test]
    fn lasts_thirty_days_from_the_second_of_login() {
        let session = Session::start(Timestamp::new(1_000, 500).unwrap()).unwrap();

        assert_eq!(session.issued_at, at(1_000));
        assert_eq!(session.expires_at, at(1_000 + 30 * 86_400));
        assert!(session.is_valid_at(at(1_000 + 30 * 86_400 - 1)));
        assert!(!session.is_valid_at(at(1_000 + 30 * 86_400)));
    }

    #[test]
    fn round_trips_through_the_cookie_value() {
        let session = Session::start(at(1_790_000_000)).unwrap();

        assert_eq!(session.to_cookie_value(), "v1.1790000000.1792592000");
        assert_eq!(
            Session::from_cookie_value(&session.to_cookie_value()),
            Some(session)
        );
    }

    #[test]
    fn ignores_a_value_of_another_format() {
        for value in ["", "v1", "v1.1", "v2.1.2", "v1.1.2.3", "v1.a.2"] {
            assert_eq!(Session::from_cookie_value(value), None, "{value}");
        }
    }
}
