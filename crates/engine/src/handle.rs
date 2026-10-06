//! The handle the rest of the application uses to talk to the engine.
//!
//! A handle is cheap to clone and safe to share between tasks. It reads the current status and
//! each wallet's sync state,
//! checks the health, subscribes to the engine's events and reads the portfolio from the source
//! of figures it was given; it cannot stop or drive the engine, which only the owner of
//! [`crate::Engine`] can do.

use std::sync::Arc;

use std::collections::BTreeMap;

use binsight_chain::RpcClient;
use binsight_solana::Address;
use binsight_store::Store;
use tokio::sync::{broadcast, watch};

use crate::events::EngineEvent;
use crate::health::{EngineHealth, check_database};
use crate::ingestion::SyncState;
use crate::portfolio::{DataSourceKind, NotReadyPortfolio, ReadModel};
use crate::status::EngineStatus;

/// A shared, read-only view of a running engine.
#[derive(Clone)]
pub struct EngineHandle {
    store: Store,
    rpc: Option<RpcClient>,
    status: watch::Receiver<EngineStatus>,
    sync_states: watch::Receiver<BTreeMap<Address, SyncState>>,
    events: broadcast::Sender<EngineEvent>,
    data_source: DataSourceKind,
    read_model: Arc<dyn ReadModel>,
}

impl std::fmt::Debug for EngineHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EngineHandle")
            .field("store", &self.store)
            .field("data_source", &self.data_source)
            .finish_non_exhaustive()
    }
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
            rpc: Some(rpc),
            status,
            sync_states,
            events,
            data_source: DataSourceKind::Chain,
            read_model: Arc::new(NotReadyPortfolio),
        }
    }

    /// A handle for an application that runs no engine (demo mode): it reports the engine as
    /// running, publishes no event and reads the portfolio from `demo`. Nothing ingests, so
    /// nothing is sent to the network.
    pub fn without_engine(store: Store, demo: Arc<dyn ReadModel>) -> Self {
        let (_status_sender, status) = watch::channel(EngineStatus::Running);
        let (events, _) = broadcast::channel(1);
        let (_sync_sender, sync_states) = watch::channel(BTreeMap::new());
        Self {
            store,
            rpc: None,
            status,
            sync_states,
            events,
            data_source: DataSourceKind::Demo,
            read_model: demo,
        }
    }

    /// Which source serves the figures.
    pub fn data_source(&self) -> DataSourceKind {
        self.data_source
    }

    /// The portfolio, as the API reads it.
    pub fn read_model(&self) -> &dyn ReadModel {
        self.read_model.as_ref()
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

    /// Checks that the database answers (with a short deadline), and reports the status and what
    /// the chain client last saw of the provider.
    pub async fn health(&self) -> EngineHealth {
        EngineHealth {
            database: check_database(&self.store).await,
            engine: self.status(),
            rpc: self.rpc.as_ref().map(|rpc| rpc.last_outcome().into()),
            stream: self.rpc.as_ref().map(|rpc| rpc.stream_snapshot().into()),
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

#[cfg(test)]
mod tests {
    use crate::health::{RpcHealth, StreamHealth};
    use crate::test_support::{
        RunningEngine, TEST_START, signature_page, temporary_engine, transaction_reply,
    };
    use binsight_chain::CallContext;
    use binsight_chain::test_support::ScriptedReply;
    use binsight_core::credits::{Priority, Purpose};
    use binsight_solana::{Address, Signature};

    #[tokio::test]
    async fn health_reads_unknown_idle_without_making_network_calls() {
        let setup = temporary_engine().await;
        for _ in 0..3 {
            let health = setup.handle.health().await;
            assert_eq!(health.rpc, Some(RpcHealth::Unknown));
            assert_eq!(health.stream, Some(StreamHealth::Idle));
        }
        assert_eq!(setup.transport.calls(), Vec::new());
        assert_eq!(setup.stream.connections_opened(), 0);
    }

    #[tokio::test]
    async fn reports_no_transport_observation_when_the_handle_serves_demo_figures() {
        let setup = temporary_engine().await;
        let handle = super::EngineHandle::without_engine(
            setup.store.clone(),
            std::sync::Arc::new(crate::portfolio::NotReadyPortfolio),
        );
        let health = handle.health().await;
        assert_eq!(health.rpc, None);
        assert_eq!(health.stream, None);
        assert_eq!(setup.transport.calls(), Vec::new());
        assert_eq!(setup.stream.connections_opened(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn health_retains_real_rpc_failure_and_recovery_without_probing() {
        let setup = temporary_engine().await;
        setup
            .transport
            .expect("getTransaction")
            .respond(ScriptedReply::RpcError {
                code: -32015,
                message: "Transaction version (2) is not supported".to_owned(),
            });
        setup
            .transport
            .expect("getTransaction")
            .respond(transaction_reply());
        let context = CallContext {
            priority: Priority::Realtime,
            purpose: Purpose::TransactionFetch,
            wallet: None,
        };
        assert!(
            setup
                .handle
                .rpc
                .as_ref()
                .unwrap()
                .transaction(Signature::from_bytes([1; 64]), context)
                .await
                .is_err()
        );
        assert_eq!(
            setup.handle.health().await.rpc,
            Some(RpcHealth::Unavailable)
        );
        assert_eq!(setup.transport.calls().len(), 1);
        assert!(
            setup
                .handle
                .rpc
                .as_ref()
                .unwrap()
                .transaction(Signature::from_bytes([2; 64]), context)
                .await
                .is_ok()
        );
        assert_eq!(setup.handle.health().await.rpc, Some(RpcHealth::Ok));
        assert_eq!(setup.transport.calls().len(), 2);
        assert_eq!(setup.stream.connections_opened(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn parked_versions_are_present_in_real_wallet_backlog() {
        let setup = temporary_engine().await;
        let wallet = Address::from_bytes([1; 32]);
        setup.store.wallets().add(wallet, TEST_START).await.unwrap();
        setup
            .transport
            .expect("getSignaturesForAddress")
            .respond(signature_page(0, 1));
        setup
            .transport
            .expect("getTransaction")
            .respond(ScriptedReply::RpcError {
                code: -32015,
                message: "Transaction version (2) is not supported".to_owned(),
            });
        let engine = RunningEngine::start(setup);
        engine
            .wait_for_counts(wallet, |counts| counts.unsupported_version == 1)
            .await;
        let backlog = engine.store.fetch_queue().backlogs().await.unwrap()[&wallet];
        assert_eq!(backlog.unsupported_version, 1);
        assert_eq!(backlog.failed, 0);
        engine.stop().await;
    }

    use binsight_ledger::report::valued::Currency;

    use crate::portfolio::{DataSourceKind, ReadError};

    #[tokio::test]
    async fn answers_not_ready_in_chain_mode() {
        let setup = temporary_engine().await;
        let handle = setup.handle;

        assert_eq!(handle.data_source(), DataSourceKind::Chain);
        let wallets = handle.read_model().wallets(Currency::Sol).await;
        assert_eq!(wallets, Err(ReadError::NotReady));
        let sync = handle.read_model().sync_report().await;
        assert_eq!(sync, Err(ReadError::NotReady));
    }
}
