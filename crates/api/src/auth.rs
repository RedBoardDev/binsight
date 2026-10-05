//! Password authentication with a signed session cookie.
//!
//! One owner, one password from the configuration. A successful login sets a signed `HttpOnly`
//! cookie; nothing is stored on the server. Failed logins slow down progressively, per client
//! address. Protected
//! routes sit behind a guard, and every state-changing request from another site is refused (see
//! `layers`). This module gathers the pieces and the state the handlers share.

mod client_address;
mod guard;
mod password;
mod public_url;
pub(crate) mod routes;
mod session;
mod settings;
mod throttle;

pub use client_address::{ClientIpHeader, ClientIpHeaderError};
pub use password::{OwnerPassword, PasswordError};
pub use public_url::{PublicUrl, PublicUrlError};
pub use session::SESSION_COOKIE_NAME;
pub use settings::{AuthSettings, SessionSecret};

pub(crate) use client_address::RequestClient;
pub(crate) use guard::require_session;
pub(crate) use session::Session;

use axum_extra::extract::cookie::Key;
use tower_http::csrf::CsrfLayer;

use crate::app::Transport;
use throttle::LoginThrottle;

/// What the authentication handlers share, built once from the [`AuthSettings`].
#[derive(Debug)]
pub(crate) struct AuthState {
    password: OwnerPassword,
    cookie_key: Key,
    is_cookie_secure: bool,
    cross_site_protection: CsrfLayer,
    client_ip_header: Option<ClientIpHeader>,
    throttle: LoginThrottle,
}

impl AuthState {
    pub(crate) fn new(settings: &AuthSettings) -> Self {
        let cross_site_protection = settings
            .public_url
            .as_ref()
            .map_or_else(CsrfLayer::new, PublicUrl::cross_site_protection);
        Self {
            password: settings.password.clone(),
            cookie_key: settings.cookie_key(),
            is_cookie_secure: settings.is_cookie_secure(),
            cross_site_protection,
            client_ip_header: settings.client_ip_header.clone(),
            throttle: LoginThrottle::default(),
        }
    }

    /// The key that signs session cookies.
    pub(crate) fn cookie_key(&self) -> &Key {
        &self.cookie_key
    }

    /// How browsers reach binsight: over HTTPS only behind an `https` public URL.
    pub(crate) fn transport(&self) -> Transport {
        if self.is_cookie_secure {
            Transport::Https
        } else {
            Transport::Http
        }
    }

    /// The cross-site request protection, trusting the public URL if there is one.
    pub(crate) fn cross_site_protection(&self) -> CsrfLayer {
        self.cross_site_protection.clone()
    }
}
