//! The engine: the long-running task that owns the background work.
//!
//! At startup the engine brings the projection bookkeeping in step with the code, restores the
//! credits already spent today and this billing cycle, and queues again the transactions parked
//! for a version it now reads; then it reports that it is running and runs ingestion and the
//! live stream until the shutdown signal, persisting the credit counts as it goes and once more
//! after both have stopped. Every status change is published both as the current status and as an event. This
//! module owns the lifecycle; what the work is belongs to other modules.

use std::collections::BTreeMap;
use std::sync::Arc;

use binsight_chain::{RpcClient, WalletStream, WsConnector};
use binsight_core::clock::Clock;
use binsight_solana::Address;
use binsight_store::Store;
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;
use tracing::info;

use crate::credit_usage::{restore_spending, run_credit_usage};
use crate::error::EngineError;
use crate::events::EngineEvent;
use crate::handle::EngineHandle;
use crate::ingestion::{
    Ingestion, IngestionParts, SyncPublisher, SyncState, requeue_readable_versions,
};
use crate::portfolio::EngineState;
use crate::projections::{REGISTRY, reconcile_projections};
use crate::status::EngineStatus;

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
    sync_states: watch::Sender<BTreeMap<Address, SyncState>>,
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
        let (sync_states, sync_receiver) = watch::channel(BTreeMap::new());
        let state = EngineState {
            store: store.clone(),
            rpc: rpc.clone(),
            clock: clock.clone(),
            status: status_receiver,
            sync_states: sync_receiver,
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
                sync_states,
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
        self.change_status(EngineStatus::Running);
        info!("engine running");
        let (stream, watch, stream_events) =
            WalletStream::new(self.stream.clone(), self.rpc.clone());
        let sync = SyncPublisher {
            states: self.sync_states.clone(),
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
    use binsight_chain::SIGNATURE_PAGE_LIMIT;
    use binsight_chain::test_support::ScriptedReply;
    use serde_json::json;

    use crate::test_support::{
        RunningEngine, TEST_START, expect_nothing_new, expect_transactions, numbered_signature,
        reopened_engine, signature_page, temporary_engine,
    };

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
        task.await.unwrap().unwrap();
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
        .unwrap()
        .unwrap();
    }

    #[tokio::test]
    async fn reports_a_working_database_as_healthy() {
        let setup = temporary_engine().await;

        let health = setup.handle.health().await;

        assert_eq!(health.database, ComponentHealth::Ok);
        assert_eq!(health.engine, EngineStatus::Starting);
    }

    #[tokio::test(start_paused = true)]
    async fn makes_no_network_call_when_no_wallet_is_tracked() {
        let engine = RunningEngine::start(temporary_engine().await);

        tokio::time::sleep(std::time::Duration::from_secs(600)).await;

        assert_eq!(engine.transport.calls(), Vec::new());
        assert_eq!(engine.stream.connections_opened(), 0);
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn resumes_after_a_restart_with_one_top_up_and_nothing_fetched_again() {
        let wallet = Address::from_bytes([1; 32]);
        let setup = temporary_engine().await;
        setup.store.wallets().add(wallet, TEST_START).await.unwrap();
        for _listing_and_its_confirmation in 0..2 {
            let listing = setup.transport.expect("getSignaturesForAddress");
            listing.respond(signature_page(0, 3));
        }
        expect_transactions(&setup.transport, 3);
        let engine = RunningEngine::start(setup);
        engine.wait_for_complete_history(wallet).await;
        engine
            .wait_for_counts(wallet, |counts| counts.fetched == 3)
            .await;
        let folder = engine.stop().await;

        let setup = reopened_engine(folder).await;
        expect_nothing_new(&setup.transport, wallet, 0);
        let restarted = RunningEngine::start(setup);
        tokio::time::sleep(std::time::Duration::from_secs(600)).await;

        assert_eq!(restarted.transport.calls().len(), 1);
        restarted.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn resumes_an_interrupted_history_from_the_last_written_page() {
        let wallet = Address::from_bytes([1; 32]);
        let full = u16::try_from(SIGNATURE_PAGE_LIMIT).unwrap();
        let setup = temporary_engine().await;
        setup.store.wallets().add(wallet, TEST_START).await.unwrap();
        let transport = &setup.transport;
        transport
            .expect("getSignaturesForAddress")
            .respond(signature_page(0, full));
        transport
            .expect("getSignaturesForAddress")
            .respond(ScriptedReply::Result(json!("not a page")));
        expect_transactions(transport, SIGNATURE_PAGE_LIMIT);
        let engine = RunningEngine::start(setup);
        while engine.transport.calls().len() < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let interrupted = engine.store.fetch_queue().counts(wallet).await.unwrap();
        let folder = engine.stop().await;

        let setup = reopened_engine(folder).await;
        let below_first_page = json!([
            wallet.to_string(),
            {"limit": 1_000, "commitment": "finalized",
             "before": numbered_signature(full - 1).to_string()}
        ]);
        for _listing_and_its_confirmation in 0..2 {
            setup
                .transport
                .expect("getSignaturesForAddress")
                .with_params(below_first_page.clone())
                .respond(signature_page(full, 2));
        }
        expect_nothing_new(&setup.transport, wallet, 0);
        let unfetched = usize::try_from(interrupted.listed - interrupted.fetched).unwrap();
        expect_transactions(&setup.transport, unfetched + 2);
        let restarted = RunningEngine::start(setup);
        restarted.wait_for_complete_history(wallet).await;
        let counts = restarted
            .wait_for_counts(wallet, |counts| counts.fetched == 1_002)
            .await;

        assert_eq!(interrupted.listed, 1_000);
        assert_eq!(counts.listed, 1_002);
        restarted.stop().await;
    }
}
