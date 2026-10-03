//! The handle the rest of the application uses to talk to the engine.
//!
//! A handle is cheap to clone and safe to share between tasks. It reads the current status,
//! checks the health and subscribes to the engine's events; it cannot stop or drive the engine,
//! which only the owner of [`crate::Engine`] can do.

use binsight_store::Store;
use tokio::sync::{broadcast, watch};

use crate::events::EngineEvent;
use crate::health::{EngineHealth, check_database};
use crate::status::EngineStatus;

/// A shared, read-only view of a running engine.
#[derive(Debug, Clone)]
pub struct EngineHandle {
    store: Store,
    status: watch::Receiver<EngineStatus>,
    events: broadcast::Sender<EngineEvent>,
}

impl EngineHandle {
    pub(crate) fn new(
        store: Store,
        status: watch::Receiver<EngineStatus>,
        events: broadcast::Sender<EngineEvent>,
    ) -> Self {
        Self {
            store,
            status,
            events,
        }
    }

    /// The current lifecycle status.
    pub fn status(&self) -> EngineStatus {
        *self.status.borrow()
    }

    /// Checks that the database answers (with a short deadline) and reports the status.
    pub async fn health(&self) -> EngineHealth {
        EngineHealth {
            database: check_database(&self.store).await,
            engine: self.status(),
        }
    }

    /// Starts receiving the events published from now on.
    ///
    /// A receiver that falls too far behind loses the oldest events and is told how many it
    /// missed; it should then refresh its state rather than rely on the stream.
    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.events.subscribe()
    }
}
