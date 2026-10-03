//! The errors that stop the engine.
//!
//! The engine only fails when it cannot do its startup work; everything later is retried or
//! reported as an event. This module only describes those failures.

use binsight_store::StoreError;

/// The engine could not run.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    /// The database could not be read or updated during startup.
    #[error("the engine could not prepare the database")]
    Store(#[from] StoreError),
}
