//! The sync monitor: how up to date each wallet is, published when it changes.
//!
//! The monitor gathers each wallet's facts (its cursor, what keeps its registry behind, its
//! subscription and checks, the provider's and the budget's refusals), decides its
//! [`SyncState`] (`sync_state`) and publishes the states: the current ones for whoever asks, and
//! an event for each one that changed. It decides again when a worker reports a change (a
//! listing written, a fetch recorded, the stream's news, a refusal), a few seconds later so a
//! burst counts once, or when a state could change with time alone. An idle instance therefore
//! leaves it asleep. The facts come from memory and one query over the fetch tasks not done yet;
//! nothing is sent to the provider.

mod sync_state;

use std::collections::BTreeMap;
use std::time::Duration;

use binsight_solana::Address;
use binsight_store::{TrackedWallet, WalletBacklog, WalletCursor};
use jiff::Timestamp;
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error};

use super::Ingestion;
use super::refusal::time_until;
use crate::engine::events::EngineEvent;
use crate::portfolio::views::SyncState;
use sync_state::{Stop, SyncFacts, next_change, sync_state};

/// How long a reported change waits for the rest of its burst before the states are decided.
const SETTLE_DELAY: Duration = Duration::from_secs(10);

/// How long the monitor waits before trying again when it cannot read the facts.
const STORE_RETRY_DELAY: Duration = Duration::from_secs(30);

/// Where the sync states go: the current ones, and an event per change.
#[derive(Debug, Clone)]
pub(crate) struct SyncPublisher {
    /// The current state of every wallet.
    pub(crate) states: watch::Sender<BTreeMap<Address, SyncState>>,
    /// The engine's events.
    pub(crate) events: broadcast::Sender<EngineEvent>,
}

/// Decides and publishes the sync states until `shutdown` is cancelled.
pub(super) async fn run_sync_monitor(ingestion: &Ingestion, shutdown: &CancellationToken) {
    loop {
        let wait = match publish_states(ingestion).await {
            Ok(next) => next.map(|at| time_until(ingestion.clock.now(), at)),
            Err(error) => {
                error!(%error, "could not read what the wallets wait for");
                Some(STORE_RETRY_DELAY)
            }
        };
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = ingestion.sync_changed.notified() => {
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = tokio::time::sleep(SETTLE_DELAY) => {}
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

/// Decides and publishes every wallet's state; returns when one could next change by itself.
async fn publish_states(
    ingestion: &Ingestion,
) -> Result<Option<Timestamp>, binsight_store::StoreError> {
    let wallets = ingestion.store.wallets().list().await?;
    let backlogs = ingestion.store.fetch_queue().backlogs().await?;
    let now = ingestion.clock.now();
    let mut states = BTreeMap::new();
    let mut next = None;
    for wallet in &wallets {
        let backlog = backlogs.get(&wallet.address).copied().unwrap_or_default();
        let facts = facts_of(ingestion, wallet, backlog, now);
        states.insert(wallet.address, sync_state(&facts, now));
        next = [next, next_change(&facts, now)].into_iter().flatten().min();
    }
    let previous = ingestion.sync.states.send_replace(states.clone());
    for (wallet, state) in states {
        if previous.get(&wallet) != Some(&state) {
            debug!(%wallet, ?state, "sync state changed");
            // Nobody listening is normal (no client connected): the event is simply dropped.
            let _ = ingestion
                .sync
                .events
                .send(EngineEvent::WalletSyncChanged { wallet, state });
        }
    }
    Ok(next)
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
