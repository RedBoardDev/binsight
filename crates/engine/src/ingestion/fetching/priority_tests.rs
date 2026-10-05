//! Live work retains a concurrency slot even while historical attempts and retries hang.

use crate::test_support::{
    RunningEngine, TEST_START, complete_history, expect_nothing_new, numbered_signature,
    transaction_reply,
};
use binsight_chain::test_support::ScriptedReply;
use binsight_core::credits::Priority;
use binsight_solana::Address;
use binsight_store::{ListedSignature, ListingPage};
use serde_json::json;
use std::time::Duration;

#[tokio::test(start_paused = true)]
async fn fetches_live_at_finalization_while_history_requests_are_still_silent() {
    const WALLET: Address = Address::from_bytes([1; 32]);
    let setup = complete_history(&[WALLET], 2_000).await;
    let cursor = setup.store.wallets().list().await.unwrap()[0].cursor;
    let signatures = (0..32)
        .map(|number| ListedSignature {
            signature: numbered_signature(number),
            slot: 100_000 - u64::from(number),
            slot_order: Some(0),
            block_time: Some(TEST_START),
            is_failed: false,
        })
        .collect();
    setup
        .store
        .signatures()
        .record_listing(ListingPage {
            wallet: WALLET,
            signatures,
            previous_cursor: cursor,
            cursor,
            fetch_priority: Priority::History,
            listed_at: TEST_START,
        })
        .await
        .unwrap();
    expect_nothing_new(&setup.transport, WALLET, 2_000);
    let live_signature = numbered_signature(5_000);
    let options = json!({
        "encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 1
    });
    setup
        .transport
        .expect("getTransaction")
        .with_params(json!([live_signature.to_string(), options]))
        .respond(transaction_reply());
    for _ in 0..96 {
        setup
            .transport
            .expect("getTransaction")
            .respond(ScriptedReply::Hang);
    }
    let engine = RunningEngine::start(setup);
    engine.wait_for_calls(4).await;
    engine.stream.notify(WALLET, live_signature, 200_000, false);
    let notified = tokio::time::Instant::now();
    engine
        .wait_for_counts(WALLET, |counts| counts.fetched == 2)
        .await;
    let latency = notified.elapsed();
    assert!(
        latency >= Duration::from_secs(13) && latency <= Duration::from_secs(15),
        "{latency:?}"
    );
    let live_calls = engine
        .transport
        .calls()
        .into_iter()
        .filter(|call| {
            call.method == "getTransaction" && call.params[0] == live_signature.to_string()
        })
        .count();
    assert_eq!(live_calls, 1);
    engine.stop().await;
}
