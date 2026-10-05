//! An unused stream hold must not suspend billable ingestion until midnight.

use crate::test_support::{
    RunningEngine, TEST_START, expect_transactions, signature_page, temporary_engine_with_limit,
};
use binsight_core::clock::utc_day;
use binsight_core::credits::Credits;
use binsight_solana::Address;
use std::time::Duration;

#[tokio::test(start_paused = true)]
async fn resumes_listing_and_fetch_after_a_pre_frame_disconnect_on_the_same_day() {
    let setup = temporary_engine_with_limit(Some(Credits(3))).await;
    let wallet = Address::from_bytes([1; 32]);
    setup.store.wallets().add(wallet, TEST_START).await.unwrap();
    setup.stream.withhold_subscription_acks();
    setup
        .transport
        .expect("getSignaturesForAddress")
        .respond(signature_page(0, 1));
    expect_transactions(&setup.transport, 1);
    let engine = RunningEngine::start(setup);
    engine.stream.wait_until_connected().await;
    let started = tokio::time::Instant::now();
    tokio::time::sleep(Duration::from_secs(12)).await;
    assert_eq!(engine.transport.calls(), Vec::new());
    engine.stream.drop_connection();
    engine
        .wait_for_counts(wallet, |counts| counts.fetched == 1)
        .await;
    assert!(
        started.elapsed() <= Duration::from_secs(14),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(engine.transport.calls().len(), 2);
    assert_eq!(engine.stream.connections_opened(), 1);
    let store = engine.store.clone();
    engine.stop().await;
    let day = utc_day(TEST_START);
    assert_eq!(
        store.credits().spent_between(day, day).await.unwrap(),
        Credits(3)
    );
}
