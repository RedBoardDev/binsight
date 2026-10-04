//! The sync monitor: how up to date each wallet is, published when it changes.
//!
//! Every 30 seconds the monitor gathers each wallet's facts (its cursor, what keeps its registry
//! behind, its subscription and checks, the provider's and the budget's refusals), decides its
//! [`SyncState`] (`sync_state`) and publishes the states: the current ones for whoever asks, and
//! an event for each one that changed. The facts come from memory and one small query per
//! wallet; nothing is sent to the provider.

mod sync_state;

pub use sync_state::SyncState;

use std::collections::BTreeMap;
use std::time::Duration;

use binsight_solana::Address;
use binsight_store::{TrackedWallet, WalletCursor};
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error};

use super::Ingestion;
use crate::events::EngineEvent;
use sync_state::{Stop, SyncFacts, sync_state};

/// How often the states are decided again.
const SYNC_INTERVAL: Duration = Duration::from_secs(30);

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
        publish_states(ingestion).await;
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = tokio::time::sleep(SYNC_INTERVAL) => {}
        }
    }
}

async fn publish_states(ingestion: &Ingestion) {
    let wallets = match ingestion.store.wallets().list().await {
        Ok(wallets) => wallets,
        Err(error) => {
            error!(%error, "could not read the tracked wallets for their sync state");
            return;
        }
    };
    let mut states = BTreeMap::new();
    for wallet in &wallets {
        match decide(ingestion, wallet).await {
            Some(state) => {
                states.insert(wallet.address, state);
            }
            None => {
                if let Some(previous) = ingestion.sync.states.borrow().get(&wallet.address) {
                    states.insert(wallet.address, *previous);
                }
            }
        }
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
}

/// `wallet`'s state now, or `None` if its facts could not be read.
async fn decide(ingestion: &Ingestion, wallet: &TrackedWallet) -> Option<SyncState> {
    let backlog = match ingestion.store.fetch_queue().backlog(wallet.address).await {
        Ok(backlog) => backlog,
        Err(error) => {
            error!(wallet = %wallet.address, %error, "could not read what a wallet waits for");
            return None;
        }
    };
    let now = ingestion.clock.now();
    let (unsubscribed_since, is_check_overdue) = ingestion.live.lag(wallet.address, now);
    let facts = SyncFacts {
        is_history_listed: matches!(wallet.cursor, WalletCursor::HistoryComplete { .. }),
        backlog,
        stop: if ingestion.is_provider_refusing(now) {
            Some(Stop::ProviderRefusal)
        } else if ingestion.rpc.credit_meter().standing().is_refusing_all {
            Some(Stop::CreditLimit)
        } else {
            None
        },
        unsubscribed_since,
        is_check_overdue,
    };
    Some(sync_state(&facts, now))
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
