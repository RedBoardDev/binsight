//! Repairs on a running engine: how far each one lists, when it runs, and what it does when the
//! node stops early, against a scripted provider and a real database.

use std::time::Duration;

use binsight_store::{ListedTop, WalletRepair};
use jiff::SignedDuration;

use super::repair_support::{
    WALLET, dated_page, fetches, list_below_the_top, repair_params, slot_of, top, wait_for_listings,
};
use crate::test_support::{
    RunningEngine, TEST_START, complete_history, expect_nothing_new, expect_transactions,
    numbered_signature, signature_page,
};

#[tokio::test(start_paused = true)]
async fn repairs_down_to_the_verified_point_and_moves_it_to_the_newest_settled_signature() {
    let setup = complete_history(&[WALLET], 2_000).await;
    let verified = ListedTop {
        signature: numbered_signature(2_010),
        slot: slot_of(2_010),
    };
    let long_ago = TEST_START
        .checked_sub(SignedDuration::from_hours(7))
        .unwrap();
    let repair = WalletRepair {
        wallet: WALLET,
        verified: Some(verified),
        repaired_at: Some(long_ago),
    };
    setup.store.repairs().record(repair).await.unwrap();
    expect_nothing_new(&setup.transport, WALLET, 2_000);
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(repair_params(WALLET, Some(2_010)))
        .respond(dated_page(&[2_000], 2));
    let engine = RunningEngine::start(setup);

    engine.wait_for_calls(2).await;
    tokio::time::sleep(Duration::from_secs(10)).await;

    let repairs = engine.store.repairs().list().await.unwrap();
    assert_eq!(repairs[0].verified, Some(top()));
    assert!(repairs[0].repaired_at.is_some_and(|at| at >= TEST_START));
    assert_eq!(fetches(&engine), 0);
    engine.stop().await;
}

#[tokio::test(start_paused = true)]
async fn leaves_the_signatures_newer_than_the_top_to_the_top_up() {
    let setup = complete_history(&[WALLET], 2_000).await;
    setup.store.repairs().ask_full(WALLET).await.unwrap();
    expect_nothing_new(&setup.transport, WALLET, 2_000);
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(repair_params(WALLET, None))
        .respond(signature_page(1_999, 2));
    let engine = RunningEngine::start(setup);

    engine.wait_for_calls(2).await;
    tokio::time::sleep(Duration::from_secs(10)).await;

    let counts = engine.store.fetch_queue().counts(WALLET).await.unwrap();
    assert_eq!(counts.listed, 1);
    engine.stop().await;
}

#[tokio::test(start_paused = true)]
async fn tries_a_full_repair_again_when_the_node_stops_above_the_oldest_listed_signature() {
    let setup = complete_history(&[WALLET], 2_000).await;
    list_below_the_top(&setup, WALLET, 2_005).await;
    setup.store.repairs().ask_full(WALLET).await.unwrap();
    expect_nothing_new(&setup.transport, WALLET, 2_000);
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(repair_params(WALLET, None))
        .respond(signature_page(2_000, 1));
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(repair_params(WALLET, None))
        .respond(signature_page(2_000, 6));
    let the_listed_one_and_the_four_gaps = 5;
    expect_transactions(&setup.transport, the_listed_one_and_the_four_gaps);
    let engine = RunningEngine::start(setup);

    wait_for_listings(&engine, 2).await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    let after_the_short_page = engine.store.repairs().list().await.unwrap();
    wait_for_listings(&engine, 3).await;
    tokio::time::sleep(Duration::from_secs(5)).await;

    assert_eq!(after_the_short_page[0].repaired_at, None);
    let repaired = engine.store.repairs().list().await.unwrap();
    assert!(repaired[0].repaired_at.is_some());
    engine.stop().await;
}

#[tokio::test(start_paused = true)]
async fn waits_six_hours_after_a_wallet_is_added_before_its_first_repair() {
    let setup = complete_history(&[WALLET], 2_000).await;
    expect_nothing_new(&setup.transport, WALLET, 2_000);
    for _cadence_until_the_repair in 0..25 {
        expect_nothing_new(&setup.transport, WALLET, 2_000);
    }
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(repair_params(WALLET, None))
        .respond(dated_page(&[2_000], 2));
    let engine = RunningEngine::start(setup);

    tokio::time::sleep(Duration::from_mins(6 * 60 - 2)).await;
    let before = engine.store.repairs().list().await.unwrap();
    tokio::time::sleep(Duration::from_mins(4)).await;

    assert_eq!(before, Vec::<WalletRepair>::new());
    let after = engine.store.repairs().list().await.unwrap();
    assert_eq!(after[0].verified, Some(top()));
    engine.stop().await;
}
