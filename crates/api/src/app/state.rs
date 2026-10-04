//! The shared state every handler can read.
//!
//! It holds handles, never data: the engine handle (the API's only way to reach the rest of
//! binsight), the clock, the authentication state, the shutdown signal that ends the live
//! streams and the files of the web app. Cloning it is cheap. This module only defines and builds
//! the state.

use std::sync::Arc;

use axum::extract::FromRef;
use axum_extra::extract::cookie::Key;
use binsight_core::clock::Clock;
use binsight_engine::EngineHandle;
use tokio_util::sync::CancellationToken;

use super::web_app::WebAssets;
use crate::auth::{AuthSettings, AuthState};

/// Everything the API is built from.
#[derive(Clone)]
pub struct AppStateParts {
    /// The engine, the API's only way to reach the rest of binsight.
    pub engine: EngineHandle,
    /// The authentication settings.
    pub auth: AuthSettings,
    /// The source of the current time.
    pub clock: Arc<dyn Clock>,
    /// Cancelled when the server shuts down; long-lived responses end on it.
    pub shutdown: CancellationToken,
    /// The files of the web app.
    pub web_assets: Arc<dyn WebAssets>,
}

/// What the HTTP layer needs from the rest of the application.
#[derive(Clone)]
pub struct AppState {
    pub(crate) engine: EngineHandle,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) auth: Arc<AuthState>,
    pub(crate) shutdown: CancellationToken,
    pub(crate) web_assets: Arc<dyn WebAssets>,
}

impl AppState {
    /// The state of an API built from `parts`.
    pub fn new(parts: AppStateParts) -> Self {
        Self {
            engine: parts.engine,
            clock: parts.clock,
            auth: Arc::new(AuthState::new(&parts.auth)),
            shutdown: parts.shutdown,
            web_assets: parts.web_assets,
        }
    }
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AppState")
            .field("engine", &self.engine)
            .finish_non_exhaustive()
    }
}

/// Lets the signed cookie jar find its key in the state.
impl FromRef<AppState> for Key {
    fn from_ref(state: &AppState) -> Self {
        state.auth.cookie_key().clone()
    }
}
