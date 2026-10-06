//! Repairs on a running engine: each kind of gap a repair finds, and how it fills it, against a
//! scripted provider and a real database.

use std::time::Duration;

use binsight_store::{FetchFailure, FetchSetback, RetryState, WalletCursor};
use jiff::SignedDuration;
use serde_json::json;

use super::repair_support::{
    OTHER, WALLET, dated_page, fetches, list_below_the_top, repair_params, slot_of, top,
};
use crate::test_support::{
    RunningEngine, TEST_START, complete_history, expect_nothing_new, expect_transactions,
    numbered_signature, signature_page,
};

#[tokio::test(start_paused = true)]
async fn fills_a_signature_an_earlier_listing_missed_without_moving_the_cursor() {
    let setup = complete_history(&[WALLET], 2_000).await;
    setup.store.repairs().ask_full(WALLET).await.unwrap();
    expect_nothing_new(&setup.transport, WALLET, 2_000);
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(repair_params(WALLET, None))
        .respond(signature_page(2_000, 2));
    expect_transactions(&setup.transport, 1);
    let engine = RunningEngine::start(setup);

    let counts = engine
        .wait_for_counts(WALLET, |counts| counts.fetched == 2)
        .await;

    assert_eq!(counts.listed, 2);
    let cursor = engine.store.wallets().list().await.unwrap()[0].cursor;
    assert_eq!(cursor, WalletCursor::HistoryComplete { top: Some(top()) });
    let fetched = &engine.transport.calls()[2];
    assert_eq!(
        fetched.params[0],
        json!(numbered_signature(2_001).to_string())
    );
    let repairs = engine.store.repairs().list().await.unwrap();
    assert!(repairs[0].repaired_at.is_some());
    engine.stop().await;
}

#[tokio::test(start_paused = true)]
async fn fetches_nothing_when_every_listed_transaction_is_already_stored() {
    let setup = complete_history(&[WALLET, OTHER], 2_000).await;
    setup.store.repairs().ask_full(WALLET).await.unwrap();
    for wallet in [WALLET, OTHER] {
        expect_nothing_new(&setup.transport, wallet, 2_000);
    }
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(repair_params(WALLET, None))
        .respond(dated_page(&[2_000], 0));
    setup.store.repairs().ask_full(OTHER).await.unwrap();
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(repair_params(OTHER, None))
        .respond(dated_page(&[2_000], 0));
    let engine = RunningEngine::start(setup);

    engine.wait_for_calls(4).await;
    tokio::time::sleep(Duration::from_secs(60)).await;

    assert_eq!(fetches(&engine), 0);
    for wallet in [WALLET, OTHER] {
        let counts = engine.store.fetch_queue().counts(wallet).await.unwrap();
        assert_eq!((counts.listed, counts.fetched), (1, 1));
    }
    engine.stop().await;
}

#[tokio::test(start_paused = true)]
async fn lists_and_marks_fetched_a_signature_another_wallet_already_fetched() {
    let setup = complete_history(&[WALLET, OTHER], 2_000).await;
    list_below_the_top(&setup, OTHER, 2_001).await;
    let stored = binsight_store::FetchedTx {
        signature: numbered_signature(2_001),
        slot: slot_of(2_001),
        block_time: Some(TEST_START),
        tx_version: binsight_solana::transaction::TxVersion::V0,
        commitment: binsight_solana::Commitment::Finalized,
        encoding: binsight_solana::transaction::TxEncoding::Base64,
        payload: br#"{"slot":2}"#.to_vec(),
        fetched_at: TEST_START,
    };
    setup.store.fetch_queue().complete(stored).await.unwrap();
    setup.store.repairs().ask_full(WALLET).await.unwrap();
    for wallet in [WALLET, OTHER] {
        expect_nothing_new(&setup.transport, wallet, 2_000);
    }
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(repair_params(WALLET, None))
        .respond(signature_page(2_000, 2));
    let engine = RunningEngine::start(setup);

    let counts = engine
        .wait_for_counts(WALLET, |counts| counts.listed == 2)
        .await;
    tokio::time::sleep(Duration::from_secs(60)).await;

    assert_eq!(counts.fetched, 2);
    assert_eq!(fetches(&engine), 0);
    engine.stop().await;
}

#[tokio::test(start_paused = true)]
async fn brings_forward_a_fetch_that_came_back_empty_once_a_repair_lists_it() {
    let setup = complete_history(&[WALLET], 2_000).await;
    list_below_the_top(&setup, WALLET, 2_001).await;
    let given_up = FetchFailure {
        signature: numbered_signature(2_001),
        setback: FetchSetback::RetryAt {
            state: RetryState::Failed,
            at: TEST_START
                .checked_add(SignedDuration::from_hours(24))
                .unwrap(),
        },
        attempts: 9,
        error: None,
        updated_at: TEST_START,
    };
    setup
        .store
        .fetch_queue()
        .record_failure(given_up)
        .await
        .unwrap();
    setup.store.repairs().ask_full(WALLET).await.unwrap();
    expect_nothing_new(&setup.transport, WALLET, 2_000);
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(repair_params(WALLET, None))
        .respond(signature_page(2_000, 2));
    expect_transactions(&setup.transport, 1);
    let engine = RunningEngine::start(setup);

    let counts = engine
        .wait_for_counts(WALLET, |counts| counts.fetched == 2)
        .await;

    assert_eq!((counts.listed, counts.failed), (2, 0));
    engine.stop().await;
}
