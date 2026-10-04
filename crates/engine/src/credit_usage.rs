//! Persisting the credits the RPC client spends.
//!
//! The chain client's meter counts every request in memory; this worker moves the counts into the
//! database every minute and once more when ingestion has stopped, so the credit report is
//! complete and the budget survives a restart: at startup, the day's and the billing cycle's
//! spending are read back into the meter before the first request. Counts that cannot be written go back to the
//! meter for the next attempt. This module moves counts; it does not decide what a request
//! costs.

use std::time::Duration;

use binsight_chain::RpcClient;
use binsight_core::clock::{Clock, utc_day};
use binsight_store::{CreditUsage, Store, StoreError};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, warn};

/// How often the counts are written to the database.
const FLUSH_INTERVAL: Duration = Duration::from_secs(60);

/// Restores what was already spent today and this billing cycle, so the budget and its limits
/// hold across restarts.
pub(crate) async fn restore_spending(
    store: &Store,
    rpc: &RpcClient,
    clock: &dyn Clock,
) -> Result<(), StoreError> {
    let today = utc_day(clock.now());
    let meter = rpc.credit_meter();
    let spent_today = store.credits().spent_between(today, today).await?;
    let cycle_first_day = meter.cycle_first_day();
    let spent_cycle = store
        .credits()
        .spent_between(cycle_first_day, today)
        .await?;
    meter.seed(spent_today, spent_cycle);
    debug!(%spent_today, %spent_cycle, %cycle_first_day, "credits spent restored");
    Ok(())
}

/// Writes the counts every minute, then a last time once `stopped` is cancelled.
pub(crate) async fn run_credit_usage(store: &Store, rpc: &RpcClient, stopped: &CancellationToken) {
    loop {
        tokio::select! {
            () = stopped.cancelled() => {
                if let Err(error) = flush(store, rpc).await {
                    error!(%error, "could not record the last credits spent; they are lost");
                }
                return;
            }
            () = tokio::time::sleep(FLUSH_INTERVAL) => {
                if let Err(error) = flush(store, rpc).await {
                    warn!(%error, "could not record the credits spent; trying again later");
                }
            }
        }
    }
}

/// Moves the meter's counts into the database; on failure they go back to the meter.
async fn flush(store: &Store, rpc: &RpcClient) -> Result<(), StoreError> {
    let meter = rpc.credit_meter();
    let drained = meter.drain();
    if drained.is_empty() {
        return Ok(());
    }
    let usages: Vec<CreditUsage> = drained.iter().map(stored_usage).collect();
    let saved = store.credits().add(usages).await;
    if saved.is_err() {
        meter.restore(drained);
    }
    saved
}

/// The meter's count as the credit ledger stores it.
fn stored_usage(usage: &binsight_chain::CreditUsage) -> CreditUsage {
    CreditUsage {
        day: usage.day,
        method: usage.method.name().to_owned(),
        priority: usage.priority,
        purpose: usage.purpose,
        wallet: usage.wallet,
        outcome: usage.outcome,
        calls: usage.calls,
        credits: usage.credits,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use binsight_chain::test_support::ScriptedReply;
    use binsight_core::clock::utc_day;
    use binsight_core::credits::{CallOutcome, Credits, Priority, Purpose};
    use binsight_solana::Address;
    use tokio::time::Instant;

    use super::*;
    use crate::test_support::{
        RunningEngine, TEST_START, expect_transactions, signature_page, temporary_engine,
        temporary_engine_with_limit,
    };

    const WALLET: Address = Address::from_bytes([1; 32]);

    #[tokio::test(start_paused = true)]
    async fn stops_every_call_at_the_daily_limit_and_persists_the_credits_spent() {
        let setup = temporary_engine_with_limit(Some(Credits(2))).await;
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        let listing = setup.transport.expect("getSignaturesForAddress");
        listing.respond(signature_page(0, 3));
        expect_transactions(&setup.transport, 3);
        let engine = RunningEngine::start(setup);

        let counts = engine
            .wait_for_counts(WALLET, |counts| counts.fetched == 1)
            .await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        let store = engine.store.clone();
        let calls = engine.transport.calls().len();
        engine.stop().await;

        assert_eq!((counts.listed, calls), (3, 2));
        let still_fetched = store.fetch_queue().counts(WALLET).await.unwrap().fetched;
        assert_eq!(still_fetched, 1);
        let today = utc_day(TEST_START);
        let spent = store.credits().spent_between(today, today).await.unwrap();
        assert_eq!(spent, Credits(2));
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_the_daily_limit_across_a_restart() {
        let setup = temporary_engine_with_limit(Some(Credits(2))).await;
        let today = utc_day(TEST_START);
        let spent_before = CreditUsage {
            day: today,
            method: "getTransaction".to_owned(),
            priority: Priority::History,
            purpose: Purpose::TransactionFetch,
            wallet: None,
            outcome: CallOutcome::Ok,
            calls: 2,
            credits: Credits(2),
        };
        setup.store.credits().add(vec![spent_before]).await.unwrap();
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        let engine = RunningEngine::start(setup);

        tokio::time::sleep(Duration::from_secs(600)).await;

        assert_eq!(engine.transport.calls(), Vec::new());
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn stops_within_two_seconds_and_persists_the_credit_counters() {
        let setup = temporary_engine().await;
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        let transport = &setup.transport;
        transport
            .expect("getSignaturesForAddress")
            .respond(signature_page(0, 1));
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::Hang);
        let engine = RunningEngine::start(setup);
        while engine.transport.calls().len() < 2 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let store = engine.store.clone();

        let stopping = Instant::now();
        engine.stop().await;

        assert!(stopping.elapsed() < Duration::from_secs(2));
        let today = utc_day(TEST_START);
        let totals = store.credits().totals_between(today, today).await.unwrap();
        let counted: Vec<(&str, CallOutcome, u64)> = totals
            .iter()
            .map(|total| (total.method.as_str(), total.outcome, total.calls))
            .collect();
        assert_eq!(
            counted,
            vec![
                ("getSignaturesForAddress", CallOutcome::Ok, 1),
                ("getTransaction", CallOutcome::Cancelled, 1),
            ]
        );
    }
}
