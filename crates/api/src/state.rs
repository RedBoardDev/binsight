//! The shared state every handler can read.
//!
//! It holds handles, never data: the engine handle (the API's only way to reach the rest of
//! binsight), the clock, and the authentication state. Cloning it is cheap. This module only
//! defines and builds the state.

use std::sync::Arc;

use axum::extract::FromRef;
use axum_extra::extract::cookie::Key;
use binsight_core::clock::Clock;
use binsight_engine::EngineHandle;

use crate::auth::{AuthSettings, AuthState};

/// What the HTTP layer needs from the rest of the application.
#[derive(Clone)]
pub struct AppState {
    pub(crate) engine: EngineHandle,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) auth: Arc<AuthState>,
}

impl AppState {
    /// The state of an API backed by `engine`, authenticating with `auth` and telling time with
    /// `clock`.
    pub fn new(engine: EngineHandle, auth: &AuthSettings, clock: Arc<dyn Clock>) -> Self {
        Self {
            engine,
            clock,
            auth: Arc::new(AuthState::new(auth)),
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
