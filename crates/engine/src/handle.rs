//! The handle the rest of the application uses to talk to the engine.
//!
//! A handle is cheap to clone and safe to share between tasks. It reads the current status and
//! each wallet's sync state, checks the health and subscribes to the engine's events; it cannot stop or drive the engine,
//! which only the owner of [`crate::Engine`] can do.

use std::collections::BTreeMap;

use binsight_chain::RpcClient;
use binsight_solana::Address;
use binsight_store::Store;
use tokio::sync::{broadcast, watch};

use crate::events::EngineEvent;
use crate::health::{EngineHealth, check_database};
use crate::ingestion::SyncState;
use crate::status::EngineStatus;

/// A shared, read-only view of a running engine.
#[derive(Debug, Clone)]
pub struct EngineHandle {
    store: Store,
    rpc: RpcClient,
    status: watch::Receiver<EngineStatus>,
    sync_states: watch::Receiver<BTreeMap<Address, SyncState>>,
    events: broadcast::Sender<EngineEvent>,
}

impl EngineHandle {
    pub(crate) fn new(
        store: Store,
        rpc: RpcClient,
        (status, sync_states): (
            watch::Receiver<EngineStatus>,
            watch::Receiver<BTreeMap<Address, SyncState>>,
        ),
        events: broadcast::Sender<EngineEvent>,
    ) -> Self {
        Self {
            store,
            rpc,
            status,
            sync_states,
            events,
        }
    }

    /// The database, for the engine's own tests.
    #[cfg(test)]
    pub(crate) fn store(&self) -> &Store {
        &self.store
    }

    /// The current lifecycle status.
    pub fn status(&self) -> EngineStatus {
        *self.status.borrow()
    }

    /// Checks that the database answers (with a short deadline), and reports the status and
    /// where the credits stand.
    pub async fn health(&self) -> EngineHealth {
        EngineHealth {
            database: check_database(&self.store).await,
            engine: self.status(),
            credits: self.rpc.credit_meter().standing().into(),
        }
    }

    /// How up to date each tracked wallet is, as last decided (empty until the first decision,
    /// a few moments after startup).
    pub fn sync_states(&self) -> BTreeMap<Address, SyncState> {
        self.sync_states.borrow().clone()
    }

    /// Starts receiving the events published from now on.
    ///
    /// A receiver that falls too far behind loses the oldest events and is told how many it
    /// missed; it should then refresh its state rather than rely on the stream.
    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.events.subscribe()
    }
}
