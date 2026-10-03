//! The shared state every handler can read.
//!
//! It holds handles, never data: the engine handle (the API's only way to reach the rest of
//! binsight), the clock, the authentication state and the shutdown signal that ends the live
//! streams. Cloning it is cheap. This module only defines and builds the state.

use std::sync::Arc;

use axum::extract::FromRef;
use axum_extra::extract::cookie::Key;
use binsight_core::clock::Clock;
use binsight_engine::EngineHandle;
use tokio_util::sync::CancellationToken;

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
}

/// What the HTTP layer needs from the rest of the application.
#[derive(Clone)]
pub struct AppState {
    pub(crate) engine: EngineHandle,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) auth: Arc<AuthState>,
    pub(crate) shutdown: CancellationToken,
}

impl AppState {
    /// The state of an API built from `parts`.
    pub fn new(parts: AppStateParts) -> Self {
        Self {
            engine: parts.engine,
            clock: parts.clock,
            auth: Arc::new(AuthState::new(&parts.auth)),
            shutdown: parts.shutdown,
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
