//! Reading the older answers a full-history catch-up meets, in the shapes nodes recorded them.
//!
//! Before mid-2022, token balances name no token program; before late 2021, no owner either, and
//! inner instructions have no stack height. A real 2021 fixture shows it; the synthetic cases
//! strip those fields from a recent fixture whose balances are all SPL Token.

#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers that edit a fixture fail loudly, like the tests"
)]

mod common;

use binsight_solana::programs::{TOKEN_2022_FIRST_INVOCATION_SLOT, TokenProgram};
use binsight_solana::transaction::{TransactionReadError, read};
use serde_json::Value;

/// A recent fixture whose token balances all belong to SPL Token.
const SPL_TOKEN_ONLY_CASE: &str = "failed-swap-through-dlmm";

/// The fixture answer at `slot`, with every token balance stripped of its program and owner.
fn without_program_and_owner(slot: u64) -> Value {
    let json = common::case(SPL_TOKEN_ONLY_CASE).transaction_json(0);
    let mut answer: Value = serde_json::from_slice(&json).unwrap();
    answer["slot"] = slot.into();
    for side in ["preTokenBalances", "postTokenBalances"] {
        for balance in answer["meta"][side].as_array_mut().unwrap() {
            let fields = balance.as_object_mut().unwrap();
            fields.remove("programId");
            fields.remove("owner");
        }
    }
    answer
}

#[test]
fn reads_a_token_balance_without_its_program_as_spl_token_before_token_2022() {
    let json = common::case(SPL_TOKEN_ONLY_CASE).transaction_json(0);
    let recent = read(&json).unwrap();
    let old = without_program_and_owner(TOKEN_2022_FIRST_INVOCATION_SLOT - 1);
    let view = read(old.to_string().as_bytes()).unwrap();
    assert_eq!(view.token_balances.len(), recent.token_balances.len());
    for (old, recent) in view.token_balances.iter().zip(&recent.token_balances) {
        assert_eq!(old.program, TokenProgram::Token);
        assert_eq!(
            (old.mint, old.pre, old.post),
            (recent.mint, recent.pre, recent.post)
        );
        assert_eq!((old.owner_pre, old.owner_post), (None, None));
    }
}

#[test]
fn refuses_a_token_balance_without_its_program_once_token_2022_exists() {
    let answer = without_program_and_owner(TOKEN_2022_FIRST_INVOCATION_SLOT);
    assert!(matches!(
        read(answer.to_string().as_bytes()),
        Err(TransactionReadError::MissingField { field: "programId" })
    ));
}

#[test]
fn still_refuses_an_answer_without_inner_instructions() {
    let mut answer = without_program_and_owner(1);
    answer["meta"]["innerInstructions"] = Value::Null;
    assert!(matches!(
        read(answer.to_string().as_bytes()),
        Err(TransactionReadError::MissingField {
            field: "innerInstructions"
        })
    ));
}

#[test]
fn reads_a_2021_transaction_whose_token_balances_name_no_program_or_owner() {
    let case = common::case("pre-2022-serum-order");
    let view = read(&case.transaction_json(0)).unwrap();
    assert!(view.slot < TOKEN_2022_FIRST_INVOCATION_SLOT);
    assert_eq!(view.fee.base, view.fee.total);
    assert_ne!(view.token_balances.len(), 0);
    assert!(view.token_balances.iter().all(|balance| {
        balance.program == TokenProgram::Token
            && balance.owner_pre.is_none()
            && balance.owner_post.is_none()
    }));
    assert!(
        view.instructions
            .iter()
            .filter(|node| node.position.inner.is_some())
            .all(|node| node.stack_height.is_none())
    );
}
