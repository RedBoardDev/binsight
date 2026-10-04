//! Answers that disagree with themselves are refused, and no input makes the reader panic.

#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers that edit a fixture fail loudly, like the tests"
)]

mod common;

use binsight_solana::transaction::{TransactionReadError, read};
use proptest::prelude::*;
use serde_json::Value;

/// The answer of `case` with its transaction bytes replaced by `bytes`.
fn with_transaction_bytes(case: &str, bytes: &[u8]) -> Vec<u8> {
    let json = common::case(case).transaction_json(0);
    let mut answer: Value = serde_json::from_slice(&json).unwrap();
    answer["transaction"][0] = common::base64_encode(bytes).into();
    answer.to_string().into_bytes()
}

/// The signed transaction bytes of `case`.
fn transaction_bytes(case: &str) -> Vec<u8> {
    let json = common::case(case).transaction_json(0);
    let answer: Value = serde_json::from_slice(&json).unwrap();
    common::base64_decode(answer["transaction"][0].as_str().unwrap())
}

#[test]
fn refuses_a_transaction_with_more_signatures_than_signers() {
    let mut bytes = transaction_bytes("legacy-sol-transfer");
    assert_eq!(bytes[0], 1, "one signature, as a compact-u16");
    bytes[0] = 2;
    let extra_signature = [7; 64];
    bytes.splice(65..65, extra_signature);
    let answer = with_transaction_bytes("legacy-sol-transfer", &bytes);
    assert!(matches!(
        read(&answer),
        Err(TransactionReadError::InvalidHeader { signatures: 2, .. })
    ));
}

#[test]
fn refuses_a_token_account_listed_twice_on_one_side() {
    let json = common::case("token2022-transfer-fee").transaction_json(0);
    let mut answer: Value = serde_json::from_slice(&json).unwrap();
    let post = answer["meta"]["postTokenBalances"].as_array_mut().unwrap();
    let copy = post[0].clone();
    post.push(copy);
    assert!(matches!(
        read(answer.to_string().as_bytes()),
        Err(TransactionReadError::DuplicateTokenBalance {
            which: "postTokenBalances",
            ..
        })
    ));
}

proptest! {
    #[test]
    fn never_panics_on_random_transaction_bytes(
        bytes in prop::collection::vec(any::<u8>(), 0..2048)
    ) {
        let _ = read(&with_transaction_bytes("v1-rebalance-liquidity", &bytes));
    }

    #[test]
    fn never_panics_on_a_mutated_or_truncated_fixture(
        case in prop::sample::select(vec![
            "legacy-sol-transfer",
            "v0-add-liquidity-alt",
            "v1-rebalance-liquidity",
        ]),
        flips in prop::collection::vec((any::<prop::sample::Index>(), any::<u8>()), 1..8),
        keep in any::<prop::sample::Index>(),
    ) {
        let mut bytes = transaction_bytes(case);
        for (index, value) in flips {
            let position = index.index(bytes.len());
            bytes[position] = value;
        }
        bytes.truncate(keep.index(bytes.len() + 1));
        let _ = read(&with_transaction_bytes(case, &bytes));
    }
}
