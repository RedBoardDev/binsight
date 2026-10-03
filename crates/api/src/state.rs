//! The shared state every handler can read.
//!
//! It holds handles, never data: the engine handle (the API's only way to reach the rest of
//! binsight). Cloning it is cheap. This module only defines and builds the state.

use binsight_engine::EngineHandle;

/// What the HTTP layer needs from the rest of the application.
#[derive(Debug, Clone)]
pub struct AppState {
    pub(crate) engine: EngineHandle,
}

impl AppState {
    /// The state of an API backed by `engine`.
    pub fn new(engine: EngineHandle) -> Self {
        Self { engine }
    }
}
