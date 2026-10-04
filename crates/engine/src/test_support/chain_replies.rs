//! Provider answers for scripted tests: numbered signatures, pages of them, and a transaction.
//!
//! The replies have the shape Helius gives them, with only the fields binsight reads, so a test
//! can script a whole history in a few lines.

use binsight_chain::test_support::{ScriptedReply, ScriptedTransport};
use binsight_solana::Signature;
use serde_json::{Value, json};

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
