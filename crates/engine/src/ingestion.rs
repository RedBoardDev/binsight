//! Ingestion: every tracked wallet's transactions, from its first to the one it just made, each
//! fetched once into the raw registry.
//!
//! Ingestion, decoding and sync reporting run side by side. The listing worker lists each
//! wallet's signatures (its whole history page by page, then again from its newest on a
//! schedule) and writes every page with its fetch tasks and the cursor move in one transaction;
//! every six hours it also repairs each listing, listing it again down to the last verified point
//! and filling the gaps it finds. The live listener turns what the stream
//! reports into fetches and into checks for the listing worker. The fetch worker reads the queue
//! of tasks the database holds and fetches what is due. The database is the only source of truth:
//! the in-memory wake-ups only save a wait. Every worker stops as soon as shutdown is requested;
//! everything they write is transactional, so stopping in the middle of a page loses nothing.
//! With no wallet tracked, nothing is ever sent, not even a stream opened.

mod decoding;
mod failure_backoff;
mod fetching;
mod listing;
mod live;
mod refusal;
mod registry_check;
mod sync;

pub use listing::{RepairEstimate, estimate_full_repair};
pub use registry_check::read_registry_findings;
pub(crate) use registry_check::{PublishedRegistryCheck, check_registry};
#[cfg(test)]
pub(crate) use sync::WalletStatus;
pub(crate) use sync::{PublishedFailures, PublishedStatuses, SyncPublisher};

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use binsight_chain::{RpcClient, StreamEvent, WalletWatch};
use binsight_core::clock::Clock;
use binsight_solana::Address;
use binsight_solana::transaction::MAX_SUPPORTED_TX_VERSION;
use binsight_store::{Store, StoreError, TrackedWallet};
use jiff::Timestamp;
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::info;

use fetching::run_fetcher;
use listing::run_listing;
use live::{LiveState, run_live_listener};
use sync::run_sync_monitor;

/// How long a worker waits after the database failed before it tries again: long enough not
/// to spin on a broken database, short enough to resume soon after it recovers.
const STORE_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(30);

/// What the ingestion workers share: the database, the RPC client, the clock, the stream's watch
/// list, the live state, the provider's latest refusal, where sync states are published, and the
/// wake-ups the workers give each other: new fetch tasks, new raw transactions, and a change the
/// sync states may follow.
#[derive(Clone)]
pub(crate) struct Ingestion {
    store: Store,
    rpc: RpcClient,
    clock: Arc<dyn Clock>,
    new_tasks: Arc<Notify>,
    new_raw: Arc<Notify>,
    sync_changed: Arc<Notify>,
    live: Arc<LiveState>,
    watch: WalletWatch,
    watched: Arc<Mutex<HashSet<Address>>>,
    provider_refuses_until: Arc<Mutex<Option<Timestamp>>>,
    sync: SyncPublisher,
}

/// What ingestion is built from.
pub(crate) struct IngestionParts {
    /// The database.
    pub(crate) store: Store,
    /// The chain client.
    pub(crate) rpc: RpcClient,
    /// The clock.
    pub(crate) clock: Arc<dyn Clock>,
    /// The stream's watch list.
    pub(crate) watch: WalletWatch,
    /// Where sync states are published.
    pub(crate) sync: SyncPublisher,
}

impl Ingestion {
    pub(crate) fn new(parts: IngestionParts) -> Self {
        let IngestionParts {
            store,
            rpc,
            clock,
            watch,
            sync,
        } = parts;
        let live = Arc::new(LiveState::new(clock.now()));
        Self {
            store,
            rpc,
            clock,
            new_tasks: Arc::new(Notify::new()),
            new_raw: Arc::new(Notify::new()),
            sync_changed: Arc::new(Notify::new()),
            live,
            watch,
            watched: Arc::new(Mutex::new(HashSet::new())),
            provider_refuses_until: Arc::new(Mutex::new(None)),
            sync,
        }
    }

    /// Runs the workers until `shutdown` is cancelled, the listener on the stream's `events`.
    pub(crate) async fn run(
        &self,
        events: mpsc::Receiver<StreamEvent>,
        shutdown: &CancellationToken,
    ) {
        tokio::join!(
            run_listing(self, shutdown),
            run_fetcher(self, shutdown),
            run_live_listener(self, events, shutdown),
            run_sync_monitor(self, shutdown),
            decoding::run_decoder(self, shutdown),
        );
    }

    /// The provider refuses every request until `until` (the key, the plan, the credits).
    fn provider_refused(&self, until: Timestamp) {
        let mut refusal = self
            .provider_refuses_until
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *refusal = Some(refusal.map_or(until, |current| current.max(until)));
        drop(refusal);
        self.sync_changed.notify_one();
    }

    /// Until when the provider refuses every request, if it does at `now`.
    fn provider_refusal_end(&self, now: Timestamp) -> Option<Timestamp> {
        self.provider_refuses_until
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .filter(|until| *until > now)
    }

    /// Asks the stream to watch the wallets of `wallets` it does not watch yet.
    fn watch_new_wallets(&self, wallets: &[TrackedWallet]) {
        let mut watched = self.watched.lock().unwrap_or_else(PoisonError::into_inner);
        watched.retain(|address| {
            if wallets.iter().any(|wallet| wallet.address == *address) {
                return true;
            }
            self.watch.unwatch(*address);
            false
        });
        for wallet in wallets {
            if watched.insert(wallet.address) {
                self.watch.watch(wallet.address);
            }
        }
    }
}

#[cfg(test)]
impl Ingestion {
    /// Ingestion on the database and scripted provider of `setup`, at the test start, with a
    /// stream that confirms every subscription; nothing runs until a test drives it.
    pub(crate) fn on_test_engine(setup: &crate::test_support::TemporaryEngine) -> Self {
        let clock = Arc::new(binsight_core::clock::FixedClock::new(
            crate::test_support::TEST_START,
        ));
        let rpc = binsight_chain::test_support::scripted_client(
            setup.transport.clone(),
            clock.clone(),
            None,
        );
        let (_, watch, _) = binsight_chain::WalletStream::new(
            binsight_chain::test_support::ScriptedConnector::new(),
            rpc.clone(),
        );
        let (statuses, _) = tokio::sync::watch::channel(None);
        let (events, _) = tokio::sync::broadcast::channel(16);
        Self::new(IngestionParts {
            store: setup.store.clone(),
            rpc,
            clock,
            watch,
            sync: SyncPublisher {
                statuses,
                failed_decodes: tokio::sync::watch::channel(None).0,
                events,
            },
        })
    }
}

/// Puts back in the fetch queue, due at `now`, the transactions parked because they were newer
/// than an older binsight could read, when this one reads them.
pub(crate) async fn requeue_readable_versions(
    store: &Store,
    now: Timestamp,
) -> Result<(), StoreError> {
    let requeued = store
        .fetch_queue()
        .requeue_unsupported_versions(MAX_SUPPORTED_TX_VERSION, now)
        .await?;
    if requeued > 0 {
        info!(
            requeued,
            "transactions of a newly readable version queued again"
        );
    }
    Ok(())
}
