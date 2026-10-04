//! Provider answers for scripted tests: numbered signatures, pages of them, and a transaction;
//! and an engine whose wallet's history is already in the registry.
//!
//! The replies have the shape Helius gives them, with only the fields binsight reads, so a test
//! can script a whole history in a few lines.

use binsight_chain::test_support::{ScriptedReply, ScriptedTransport};
use binsight_core::credits::Priority;
use binsight_solana::transaction::{TxEncoding, TxVersion};
use binsight_solana::{Address, Commitment, Signature};
use binsight_store::{FetchedTx, ListedSignature, ListedTop, ListingPage, WalletCursor};
use serde_json::{Value, json};

use super::{TEST_START, TemporaryEngine, temporary_engine};

/// The slot of the newest signature of a page built by [`signature_page`]; each next signature
/// is one slot older.
const NEWEST_SLOT: u64 = 100_000;

/// The signature numbered `number`, distinct for every number.
pub fn numbered_signature(number: u16) -> Signature {
    let [high, low] = number.to_be_bytes();
    let mut bytes = [low; 64];
    bytes[0] = high;
    bytes[1] = 0xA5;
    Signature::from_bytes(bytes)
}

/// A `getSignaturesForAddress` page of `count` successful signatures numbered from `first`,
/// one per slot, newest first.
pub fn signature_page(first: u16, count: u16) -> ScriptedReply {
    let entries: Vec<Value> = (first..first.saturating_add(count))
        .map(|number| {
            json!({
                "signature": numbered_signature(number).to_string(),
                "slot": NEWEST_SLOT.saturating_sub(u64::from(number)),
                "err": null,
                "blockTime": 1_790_000_000,
            })
        })
        .collect();
    ScriptedReply::Result(Value::Array(entries))
}

/// A `getTransaction` answer for a successful version 0 transaction.
pub fn transaction_reply() -> ScriptedReply {
    ScriptedReply::Result(json!({
        "slot": 99_000,
        "blockTime": 1_790_000_000,
        "version": 0,
        "meta": {"err": null, "fee": 5000},
        "transaction": ["AQID", "base64"],
    }))
}

/// Expects `count` more `getTransaction` calls, each answered with [`transaction_reply`].
pub fn expect_transactions(transport: &ScriptedTransport, count: usize) {
    for _ in 0..count {
        transport
            .expect("getTransaction")
            .respond(transaction_reply());
    }
}

/// Expects one listing of `wallet`'s signatures newer than the one numbered `top` (a top-up or
/// a check), answered with nothing new.
pub fn expect_nothing_new(transport: &ScriptedTransport, wallet: Address, top: u16) {
    let params = json!([
        wallet.to_string(),
        {"limit": 1_000, "commitment": "finalized", "until": numbered_signature(top).to_string()}
    ]);
    transport
        .expect("getSignaturesForAddress")
        .with_params(params)
        .respond(ScriptedReply::Result(json!([])));
}

/// An engine whose `wallets` each have a complete history of the same fetched transaction,
/// numbered `newest`: their top.
///
/// # Panics
///
/// Panics if the database cannot be written.
#[expect(
    clippy::expect_used,
    reason = "test support: a failed setup must stop the test immediately"
)]
pub async fn complete_history(wallets: &[Address], newest: u16) -> TemporaryEngine {
    let setup = temporary_engine().await;
    let signature = numbered_signature(newest);
    let slot = NEWEST_SLOT.saturating_sub(u64::from(newest));
    let store = &setup.store;
    for wallet in wallets {
        store
            .wallets()
            .add(*wallet, TEST_START)
            .await
            .expect("could not add the wallet");
        let listing = ListingPage {
            wallet: *wallet,
            signatures: vec![ListedSignature {
                signature,
                slot,
                slot_order: Some(0),
                block_time: Some(TEST_START),
                is_failed: false,
            }],
            previous_cursor: WalletCursor::NotStarted,
            cursor: WalletCursor::HistoryComplete {
                top: Some(ListedTop { signature, slot }),
            },
            fetch_priority: Priority::History,
            listed_at: TEST_START,
        };
        store
            .signatures()
            .record_listing(listing)
            .await
            .expect("could not list the history");
    }
    let fetched = FetchedTx {
        signature,
        slot,
        block_time: Some(TEST_START),
        tx_version: TxVersion::V0,
        commitment: Commitment::Finalized,
        encoding: TxEncoding::Base64,
        payload: br#"{"slot":1}"#.to_vec(),
        fetched_at: TEST_START,
    };
    store
        .fetch_queue()
        .complete(fetched)
        .await
        .expect("could not fetch the history");
    setup
}
