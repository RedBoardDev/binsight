//! The sync monitor: how up to date each wallet is, published when it changes.
//!
//! The monitor reads each wallet's progress (its cursor, what keeps its registry behind, how much
//! is listed: one snapshot of the database), gathers the facts the engine holds in memory (its
//! subscription and checks, the provider's and the budget's refusals), decides its
//! [`SyncState`] (`sync_state`) and publishes the result: every wallet's progress and state for
//! whoever reads them (the sync report and the wallet list read them from there instead of the
//! database), and an event for each state that changed. It decides again when a worker reports a
//! change (a listing written, a fetch recorded, the stream's news, a refusal), a few seconds
//! later so a burst counts once (longer while a wallet imports, when changes come in streams), or
//! when a state could change with time alone. An idle instance therefore leaves it asleep.
//! Nothing is sent to the provider.

mod sync_state;

use std::sync::Arc;
use std::time::Duration;

use binsight_store::{TrackedWallet, WalletBacklog, WalletCursor, WalletProgress};
use jiff::Timestamp;
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error};

use super::refusal::time_until;
use super::{Ingestion, STORE_RETRY_DELAY};
use crate::engine::events::EngineEvent;
use crate::portfolio::views::SyncState;
use sync_state::{Stop, SyncFacts, next_change, sync_state};

/// How long a reported change waits for the rest of its burst before the states are decided.
const SETTLE_DELAY: Duration = Duration::from_secs(10);

/// The same wait while a wallet imports its history, when every fetch reports a change.
const IMPORT_SETTLE_DELAY: Duration = Duration::from_secs(30);

/// A wallet's progress as the monitor last read it, and the state it decided from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WalletStatus {
    /// The wallet and how far its ingestion is.
    pub(crate) progress: WalletProgress,
    /// How up to date it is.
    pub(crate) state: SyncState,
}

/// What the monitor publishes: every wallet's status, the oldest wallet first; `None` until its
/// first decision, a few moments after startup.
pub(crate) type PublishedStatuses = Option<Arc<Vec<WalletStatus>>>;

/// What the decoder publishes: how many transactions of the registry could not be decoded;
/// `None` until its first scan, a few moments after startup.
pub(crate) type PublishedFailures = Option<u64>;

/// Where the sync states go: the current ones, and an event per change.
#[derive(Debug, Clone)]
pub(crate) struct SyncPublisher {
    /// The current status of every wallet.
    pub(crate) statuses: watch::Sender<PublishedStatuses>,
    /// How many transactions could not be decoded, as the decoder last counted them.
    pub(crate) failed_decodes: watch::Sender<PublishedFailures>,
    /// The engine's events.
    pub(crate) events: broadcast::Sender<EngineEvent>,
}

/// Decides and publishes the sync states until `shutdown` is cancelled.
pub(super) async fn run_sync_monitor(ingestion: &Ingestion, shutdown: &CancellationToken) {
    loop {
        let (wait, settle) = match publish_states(ingestion).await {
            Ok(decision) => (
                decision
                    .next
                    .map(|at| time_until(ingestion.clock.now(), at)),
                if decision.is_importing {
                    IMPORT_SETTLE_DELAY
                } else {
                    SETTLE_DELAY
                },
            ),
            Err(error) => {
                error!(%error, "could not read what the wallets wait for");
                (Some(STORE_RETRY_DELAY), SETTLE_DELAY)
            }
        };
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = ingestion.sync_changed.notified() => {
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = tokio::time::sleep(settle) => {}
                }
            }
            () = sleep_for(wait) => {}
        }
    }
}

/// Sleeps for `wait`, or forever without one.
async fn sleep_for(wait: Option<Duration>) {
    match wait {
        Some(wait) => tokio::time::sleep(wait).await,
        None => std::future::pending().await,
    }
}

/// What one decision found out about the time ahead.
struct Decision {
    /// When a state could next change by itself, if one can.
    next: Option<Timestamp>,
    /// Whether a wallet imports its history.
    is_importing: bool,
}

/// Decides and publishes every wallet's state.
async fn publish_states(ingestion: &Ingestion) -> Result<Decision, binsight_store::StoreError> {
    let wallets = ingestion.store.wallets().progress().await?;
    let now = ingestion.clock.now();
    let mut statuses = Vec::with_capacity(wallets.len());
    let mut next = None;
    for progress in wallets {
        let facts = facts_of(ingestion, &progress.wallet, progress.backlog, now);
        statuses.push(WalletStatus {
            progress,
            state: sync_state(&facts, now),
        });
        next = [next, next_change(&facts, now)].into_iter().flatten().min();
    }
    let is_importing = statuses
        .iter()
        .any(|status| status.state == SyncState::Importing);
    let previous = ingestion
        .sync
        .statuses
        .send_replace(Some(Arc::new(statuses.clone())));
    for status in statuses {
        let (wallet, state) = (status.progress.wallet.address, status.state);
        let was = previous.as_ref().and_then(|previous| {
            previous
                .iter()
                .find(|old| old.progress.wallet.address == wallet)
                .map(|old| old.state)
        });
        if was != Some(state) {
            debug!(%wallet, ?state, "sync state changed");
            // Nobody listening is normal (no client connected): the event is simply dropped.
            let _ = ingestion
                .sync
                .events
                .send(EngineEvent::WalletSyncChanged { wallet, state });
        }
    }
    Ok(Decision { next, is_importing })
}

/// What `wallet`'s state is decided from at `now`.
fn facts_of(
    ingestion: &Ingestion,
    wallet: &TrackedWallet,
    backlog: WalletBacklog,
    now: Timestamp,
) -> SyncFacts {
    let lag = ingestion.live.lag(wallet.address);
    let stop = match ingestion.provider_refusal_end(now) {
        Some(until) => Some(Stop::ProviderRefusal { until }),
        None if ingestion.rpc.credit_meter().standing().is_refusing_all => Some(Stop::CreditLimit),
        None => None,
    };
    SyncFacts {
        is_history_listed: matches!(wallet.cursor, WalletCursor::HistoryComplete { .. }),
        backlog,
        stop,
        unsubscribed_since: lag.unsubscribed_since,
        check_late_after: lag.late_after,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use binsight_solana::Address;
    use tokio::sync::broadcast;

    use super::*;
    use crate::test_support::{
        RunningEngine, TEST_START, complete_history, expect_nothing_new, expect_transactions,
        signature_page, temporary_engine,
    };

    const WALLET: Address = Address::from_bytes([1; 32]);

    /// The next sync state published for a wallet.
    async fn next_sync_change(
        events: &mut broadcast::Receiver<EngineEvent>,
    ) -> (Address, SyncState) {
        loop {
            let event = tokio::time::timeout(Duration::from_secs(3_600), events.recv())
                .await
                .expect("no sync change came")
                .expect("the engine stopped publishing");
            if let EngineEvent::WalletSyncChanged { wallet, state } = event {
                return (wallet, state);
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn announces_a_wallet_live_once_its_history_is_in_the_registry() {
        let setup = complete_history(&[WALLET], 2_000).await;
        expect_nothing_new(&setup.transport, WALLET, 2_000);
        let mut events = setup.handle.subscribe();
        let handle = setup.handle.clone();
        let engine = RunningEngine::start(setup);

        assert_eq!(
            next_sync_change(&mut events).await,
            (WALLET, SyncState::Live)
        );
        assert_eq!(handle.sync_states().get(&WALLET), Some(&SyncState::Live));
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn says_a_wallet_lags_while_its_subscription_is_refused() {
        let setup = complete_history(&[WALLET], 2_000).await;
        setup.stream.refuse_subscriptions(-32_600, "not available");
        for _startup_and_every_minute in 0..3 {
            expect_nothing_new(&setup.transport, WALLET, 2_000);
        }
        let mut events = setup.handle.subscribe();
        let engine = RunningEngine::start(setup);

        assert_eq!(
            next_sync_change(&mut events).await,
            (WALLET, SyncState::Live)
        );
        assert_eq!(
            next_sync_change(&mut events).await,
            (WALLET, SyncState::Lagging)
        );
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn says_a_wallet_imports_until_its_history_is_listed_and_fetched() {
        let setup = temporary_engine().await;
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        for _listing_and_its_confirmation in 0..2 {
            let listing = setup.transport.expect("getSignaturesForAddress");
            listing.respond(signature_page(0, 1));
        }
        expect_transactions(&setup.transport, 1);
        let mut events = setup.handle.subscribe();
        let engine = RunningEngine::start(setup);

        assert_eq!(
            next_sync_change(&mut events).await,
            (WALLET, SyncState::Importing)
        );
        engine.stop().await;
    }
}
