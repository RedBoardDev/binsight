//! The lifecycle status of the engine.
//!
//! The status only moves forward: starting, then running, then stopping. This module names the
//! states; the engine decides when to move between them.

/// Where the engine is in its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EngineStatus {
    /// Built but not yet running its startup work.
    Starting,
    /// Running normally.
    Running,
    /// Shutting down; no new work starts.
    Stopping,
}
