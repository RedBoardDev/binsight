//! What the repair tests share: a wallet listed down to a known top, repair pages, and counts
//! of what the scripted provider received.

use std::time::Duration;

use binsight_chain::test_support::ScriptedReply;
use binsight_solana::Address;
use binsight_store::{ListedSignature, ListedTop, ListingPage, WalletCursor};
use jiff::SignedDuration;
use serde_json::{Value, json};

use crate::test_support::{RunningEngine, TEST_START, TemporaryEngine, numbered_signature};

pub(super) const WALLET: Address = Address::from_bytes([1; 32]);
pub(super) const OTHER: Address = Address::from_bytes([2; 32]);

/// The slot of the signature numbered `number` in `signature_page`.
pub(super) fn slot_of(number: u16) -> u64 {
    100_000 - u64::from(number)
}

/// The cursor's top of a wallet whose history is listed down to the signature numbered 2,000.
pub(super) fn top() -> ListedTop {
    ListedTop {
        signature: numbered_signature(2_000),
        slot: slot_of(2_000),
    }
}

/// The parameters of a repair page of `wallet`, down to the signature numbered `until`.
pub(super) fn repair_params(wallet: Address, until: Option<u16>) -> Value {
    let mut options = json!({"limit": 1_000, "commitment": "finalized"});
    if let Some(until) = until {
        options["until"] = json!(numbered_signature(until).to_string());
    }
    json!([wallet.to_string(), options])
}

/// A page of the signatures numbered `numbers`, newest first, produced `hours_ago`.
pub(super) fn dated_page(numbers: &[u16], hours_ago: i64) -> ScriptedReply {
    let block_time = TEST_START
        .checked_sub(SignedDuration::from_hours(hours_ago))
        .unwrap()
        .as_second();
    let entries: Vec<Value> = numbers
        .iter()
        .map(|number| {
            json!({
                "signature": numbered_signature(*number).to_string(),
                "slot": slot_of(*number),
                "err": null,
                "blockTime": block_time,
            })
        })
        .collect();
    ScriptedReply::Result(Value::Array(entries))
}

/// Lists the signature numbered `number` for `wallet`, below its top, as an earlier listing
/// would have.
pub(super) async fn list_below_the_top(setup: &TemporaryEngine, wallet: Address, number: u16) {
    let cursor = WalletCursor::HistoryComplete { top: Some(top()) };
    let page = ListingPage {
        wallet,
        signatures: vec![ListedSignature {
            signature: numbered_signature(number),
            slot: slot_of(number),
            block_time: Some(TEST_START),
            is_failed: false,
        }],
        previous_cursor: cursor,
        cursor,
        fetch_priority: binsight_core::credits::Priority::History,
        listed_at: TEST_START,
    };
    setup.store.signatures().record_listing(page).await.unwrap();
}

/// How many calls of `method` the provider received.
pub(super) fn calls_of(engine: &RunningEngine, method: &str) -> usize {
    engine
        .transport
        .calls()
        .iter()
        .filter(|call| call.method == method)
        .count()
}

/// How many `getTransaction` calls the provider received.
pub(super) fn fetches(engine: &RunningEngine) -> usize {
    calls_of(engine, "getTransaction")
}

/// Waits until the provider received `count` listings.
pub(super) async fn wait_for_listings(engine: &RunningEngine, count: usize) {
    while calls_of(engine, "getSignaturesForAddress") < count {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
