//! The engine: the long-running task that owns the background work.
//!
//! In this first version the engine has no work yet: it starts, reports that it is running and
//! waits for the shutdown signal. Every status change is published both as the current status and
//! as an event. This module owns the lifecycle; what the work is belongs to later modules.

use binsight_store::Store;
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;
use tracing::info;

use crate::events::EngineEvent;
use crate::handle::EngineHandle;
use crate::status::EngineStatus;

/// How many events a slow subscriber may fall behind before it starts losing the oldest ones.
const EVENT_BUFFER_SIZE: usize = 256;

/// The engine, ready to run.
#[derive(Debug)]
pub struct Engine {
    status: watch::Sender<EngineStatus>,
    events: broadcast::Sender<EngineEvent>,
}

impl Engine {
    /// Builds an engine on `store` and the handle to share with the rest of the application.
    /// The engine does nothing until [`Engine::run`] is called.
    pub fn new(store: Store) -> (Self, EngineHandle) {
        let (status, status_receiver) = watch::channel(EngineStatus::Starting);
        let (events, _) = broadcast::channel(EVENT_BUFFER_SIZE);
        let handle = EngineHandle::new(store, status_receiver, events.clone());
        (Self { status, events }, handle)
    }

    /// Runs the engine until `shutdown` is cancelled.
    pub async fn run(self, shutdown: CancellationToken) {
        self.change_status(EngineStatus::Running);
        info!("engine running");
        shutdown.cancelled().await;
        self.change_status(EngineStatus::Stopping);
        info!("engine stopped");
    }

    /// Records the new status and tells the subscribers.
    fn change_status(&self, status: EngineStatus) {
        self.status.send_replace(status);
        // Nobody listening is normal (no client connected): the event is simply dropped.
        let _ = self.events.send(EngineEvent::StatusChanged { status });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::ComponentHealth;
    use crate::test_support::temporary_engine;

    #[tokio::test]
    async fn moves_from_starting_to_running_to_stopping() {
        let setup = temporary_engine().await;
        let handle = setup.handle;
        let mut events = handle.subscribe();
        let shutdown = CancellationToken::new();
        assert_eq!(handle.status(), EngineStatus::Starting);

        let task = tokio::spawn(setup.engine.run(shutdown.clone()));
        let running = events.recv().await.unwrap();
        assert_eq!(handle.status(), EngineStatus::Running);
        shutdown.cancel();
        task.await.unwrap();
        let stopping = events.recv().await.unwrap();

        assert_eq!(
            running,
            EngineEvent::StatusChanged {
                status: EngineStatus::Running
            }
        );
        assert_eq!(
            stopping,
            EngineEvent::StatusChanged {
                status: EngineStatus::Stopping
            }
        );
        assert_eq!(handle.status(), EngineStatus::Stopping);
    }

    #[tokio::test]
    async fn returns_as_soon_as_the_shutdown_is_requested() {
        let setup = temporary_engine().await;
        let shutdown = CancellationToken::new();
        shutdown.cancel();

        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            setup.engine.run(shutdown),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn reports_a_working_database_as_healthy() {
        let setup = temporary_engine().await;

        let health = setup.handle.health().await;

        assert_eq!(health.database, ComponentHealth::Ok);
        assert_eq!(health.engine, EngineStatus::Starting);
    }
}
