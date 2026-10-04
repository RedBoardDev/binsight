//! Ingestion: listing the history of every tracked wallet and fetching each listed transaction
//! once, into the raw registry.
//!
//! Two workers run side by side. The listing worker lists each wallet's signatures page by page,
//! and writes every page with its fetch tasks and the cursor move in one transaction. The fetch
//! worker reads the queue of tasks the database holds and fetches what is due. The database is
//! the only source of truth: the in-memory wake-up only saves the fetcher a wait. Both workers
//! stop as soon as shutdown is requested; everything they write is transactional, so stopping
//! in the middle of a page loses nothing. With no wallet tracked, nothing is ever sent.

mod cursor;
mod fetch_batch;
mod fetch_outcome;
mod fetcher;
mod history_end;
mod history_page;
mod listing;
mod listing_schedule;
mod refusal;
mod slot_order;

use std::sync::Arc;

use binsight_chain::RpcClient;
use binsight_core::clock::Clock;
use binsight_solana::transaction::MAX_SUPPORTED_TX_VERSION;
use binsight_store::{Store, StoreError};
use jiff::Timestamp;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tracing::info;

use fetcher::run_fetcher;
use listing::run_listing;

/// What the ingestion workers share: the database, the RPC client, the clock, and the wake-up
/// the listing gives the fetcher when it queues new tasks.
#[derive(Clone)]
pub(crate) struct Ingestion {
    store: Store,
    rpc: RpcClient,
    clock: Arc<dyn Clock>,
    new_tasks: Arc<Notify>,
}

impl Ingestion {
    pub(crate) fn new(store: Store, rpc: RpcClient, clock: Arc<dyn Clock>) -> Self {
        Self {
            store,
            rpc,
            clock,
            new_tasks: Arc::new(Notify::new()),
        }
    }

    /// Runs the listing and fetch workers until `shutdown` is cancelled.
    pub(crate) async fn run(&self, shutdown: &CancellationToken) {
        tokio::join!(run_listing(self, shutdown), run_fetcher(self, shutdown));
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
