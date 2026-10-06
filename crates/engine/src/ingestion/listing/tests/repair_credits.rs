//! A repair spends exactly the credits it planned: its planned requests, times their price, are
//! what the credit meter counts.

use binsight_chain::StreamEvent;
use binsight_core::credits::{Priority, Purpose};
use binsight_store::{ListedSignature, ListedTop, ListingPage, WalletCursor};
use serde_json::json;

use super::repair_support::{WALLET, repair_params, slot_of};
use crate::ingestion::Ingestion;
use crate::ingestion::listing::listing_step::{ListingWorker, Progress};
use crate::ingestion::listing::repair_rules::estimate_full_repair;
use crate::test_support::{
    TEST_START, expect_nothing_new, numbered_signature, signature_page, temporary_engine,
};

/// How many signatures the wallet lists: two full pages and a shorter one.
const LISTED: u16 = 2_500;

/// The parameters of the repair page of [`WALLET`] older than the signature numbered `before`.
fn page_below(before: u16) -> serde_json::Value {
    let mut params = repair_params(WALLET, None);
    params[1]["before"] = json!(numbered_signature(before).to_string());
    params
}

#[tokio::test(start_paused = true)]
async fn spends_exactly_the_credits_a_full_repair_planned() {
    let setup = temporary_engine().await;
    setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
    let history = ListingPage {
        wallet: WALLET,
        signatures: (0..LISTED)
            .map(|number| ListedSignature {
                signature: numbered_signature(number),
                slot: slot_of(number),
                block_time: Some(TEST_START),
                is_failed: false,
            })
            .collect(),
        previous_cursor: WalletCursor::NotStarted,
        cursor: WalletCursor::HistoryComplete {
            top: Some(ListedTop {
                signature: numbered_signature(0),
                slot: slot_of(0),
            }),
        },
        fetch_priority: Priority::History,
        listed_at: TEST_START,
    };
    setup
        .store
        .signatures()
        .record_listing(history)
        .await
        .unwrap();
    setup.store.repairs().ask_full(WALLET).await.unwrap();
    let transport = &setup.transport;
    expect_nothing_new(transport, WALLET, 0);
    let pages = [
        (repair_params(WALLET, None), signature_page(0, 1_000)),
        (page_below(999), signature_page(1_000, 1_000)),
        (page_below(1_999), signature_page(2_000, 500)),
    ];
    for (params, page) in pages {
        transport
            .expect("getSignaturesForAddress")
            .with_params(params)
            .respond(page);
    }
    let ingestion = Ingestion::on_test_engine(&setup);
    let subscribed = StreamEvent::Subscribed { wallet: WALLET };
    ingestion.live.apply(&subscribed, TEST_START);
    let mut worker = ListingWorker::default();

    while matches!(worker.step(&ingestion).await, Progress::Continue) {}

    let repaired = setup.store.repairs().list().await.unwrap();
    assert!(repaired[0].repaired_at.is_some());
    let plan = estimate_full_repair(u64::from(LISTED));
    let spent: Vec<_> = ingestion
        .rpc
        .credit_meter()
        .drain()
        .into_iter()
        .filter(|usage| usage.purpose == Purpose::Repair)
        .collect();
    let calls: u64 = spent.iter().map(|usage| usage.calls).sum();
    let credits: u64 = spent.iter().map(|usage| usage.credits.0).sum();
    assert_eq!(calls, plan.listing_requests);
    assert_eq!(credits, plan.credits.0);
    assert!(
        spent
            .iter()
            .all(|usage| usage.priority == Priority::History)
    );
    transport.assert_no_unexpected_calls();
}
