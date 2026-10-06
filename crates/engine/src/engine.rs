//! The engine: the long-running task that owns the background work.
//!
//! At startup the engine brings the projection bookkeeping in step with the code, restores the
//! credits already spent today and this billing cycle, queues again the transactions parked for
//! a version it now reads, and checks the registry's consistency (publishing what it found);
//! then it reports that it is running and runs ingestion and the
//! live stream until the shutdown signal, persisting the credit counts as it goes and once more
//! after both have stopped. Every status change is published both as the current status and as an event. This
//! module owns the lifecycle, with its status (`status`), its events (`events`) and its health
//! (`health`); what the work is belongs to other modules.

pub(crate) mod events;
pub(crate) mod health;
pub(crate) mod status;

use std::sync::Arc;

use binsight_chain::{RpcClient, WalletStream, WsConnector};
use binsight_core::clock::Clock;
use binsight_store::Store;
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;
use tracing::{error, info};

use crate::credit_usage::{restore_spending, run_credit_usage};
use crate::error::EngineError;
use crate::handle::EngineHandle;
use crate::ingestion::{Ingestion, IngestionParts, SyncPublisher, requeue_readable_versions};
use crate::ingestion::{
    PublishedFailures, PublishedRegistryCheck, PublishedStatuses, check_registry,
};
use crate::portfolio::EngineState;
use crate::projections::{REGISTRY, reconcile_projections};
use events::EngineEvent;
use status::EngineStatus;

/// How many events a slow subscriber may fall behind before it starts losing the oldest ones.
const EVENT_BUFFER_SIZE: usize = 256;

/// The engine, ready to run.
pub struct Engine {
    store: Store,
    rpc: RpcClient,
    stream: Arc<dyn WsConnector>,
    clock: Arc<dyn Clock>,
    status: watch::Sender<EngineStatus>,
    events: broadcast::Sender<EngineEvent>,
    sync_statuses: watch::Sender<PublishedStatuses>,
    failed_decodes: watch::Sender<PublishedFailures>,
    registry_check: watch::Sender<PublishedRegistryCheck>,
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Engine").finish_non_exhaustive()
    }
}

impl Engine {
    /// Builds an engine on `store` that reaches the chain through `rpc` and the live stream
    /// through `stream`, and reads the time from `clock`, and the handle to share with the rest
    /// of the application. The engine does nothing until [`Engine::run`] is called.
    pub fn new(
        store: Store,
        rpc: RpcClient,
        stream: Arc<dyn WsConnector>,
        clock: Arc<dyn Clock>,
    ) -> (Self, EngineHandle) {
        let (status, status_receiver) = watch::channel(EngineStatus::Starting);
        let (events, _) = broadcast::channel(EVENT_BUFFER_SIZE);
        let (sync_statuses, sync_receiver) = watch::channel(None);
        let (failed_decodes, failures_receiver) = watch::channel(None);
        let (registry_check, check_receiver) = watch::channel(None);
        let state = EngineState {
            store: store.clone(),
            rpc: rpc.clone(),
            clock: clock.clone(),
            status: status_receiver,
            sync_statuses: sync_receiver,
            failed_decodes: failures_receiver,
            registry_check: check_receiver,
        };
        let handle = EngineHandle::new(state, events.clone());
        (
            Self {
                store,
                rpc,
                stream,
                clock,
                status,
                events,
                sync_statuses,
                failed_decodes,
                registry_check,
            },
            handle,
        )
    }

    /// Runs the startup work, then ingestion until `shutdown` is cancelled.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::Store`] if the startup work cannot read or update the database; the
    /// engine never reaches the running status then.
    pub async fn run(self, shutdown: CancellationToken) -> Result<(), EngineError> {
        reconcile_projections(&self.store, REGISTRY).await?;
        restore_spending(&self.store, &self.rpc, self.clock.as_ref()).await?;
        requeue_readable_versions(&self.store, self.clock.now()).await?;
        self.check_registry().await;
        self.change_status(EngineStatus::Running);
        info!("engine running");
        let (stream, watch, stream_events) =
            WalletStream::new(self.stream.clone(), self.rpc.clone());
        let sync = SyncPublisher {
            statuses: self.sync_statuses.clone(),
            failed_decodes: self.failed_decodes.clone(),
            events: self.events.clone(),
        };
        let ingestion = Ingestion::new(IngestionParts {
            store: self.store.clone(),
            rpc: self.rpc.clone(),
            clock: self.clock.clone(),
            watch,
            sync,
        });
        let ingestion_stopped = CancellationToken::new();
        tokio::join!(
            async {
                tokio::join!(
                    ingestion.run(stream_events, &shutdown),
                    stream.run(shutdown.cancelled()),
                );
                ingestion_stopped.cancel();
            },
            run_credit_usage(&self.store, &self.rpc, &ingestion_stopped),
        );
        self.change_status(EngineStatus::Stopping);
        info!("engine stopped");
        Ok(())
    }

    /// Checks the registry and publishes what the check found; a check that cannot run is
    /// logged, and the engine starts anyway.
    async fn check_registry(&self) {
        match check_registry(&self.store, self.clock.now()).await {
            Ok(check) => {
                self.registry_check.send_replace(Some(Arc::new(check)));
            }
            Err(error) => error!(%error, "could not check the registry; the engine starts anyway"),
        }
    }

    /// Records the new status and tells the subscribers.
    fn change_status(&self, status: EngineStatus) {
        self.status.send_replace(status);
        // Nobody listening is normal (no client connected): the event is simply dropped.
        let _ = self.events.send(EngineEvent::StatusChanged { status });
    }
}

#[cfg(test)]
mod tests;
