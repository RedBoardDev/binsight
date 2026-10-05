//! Gross/net adjustments follow each DLMM emitting call, including nested sibling calls.
mod common;
use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::TxActivity;
use binsight_ledger::book::{EntryKind, WalletContext, book_transaction};
use binsight_solana::{
    transaction::{InstructionPosition, TransactionView},
    well_known::TOKEN_2022_PROGRAM,
};
use common::positions::deposit;
use common::*;

#[expect(
    clippy::indexing_slicing,
    reason = "two known fixture calls, transfers and movements are duplicated"
)]
fn two_deposits() -> (WalletContext, TransactionView, TxActivity) {
    let (wallet, mut tx, mut activity) = deposit();
    tx.token_balances[0].pre = RawTokenAmount(2_000);
    tx.token_balances[1].post = RawTokenAmount(1_900);
    let mut second_call = tx.instructions[0].clone();
    second_call.position.top = 1;
    let mut second_transfer = tx.instructions[1].clone();
    tx.instructions[1].position = InstructionPosition {
        top: 0,
        inner: Some(0),
    };
    tx.instructions[1].stack_height = Some(2);
    second_transfer.position = InstructionPosition {
        top: 1,
        inner: Some(0),
    };
    second_transfer.stack_height = Some(2);
    tx.instructions.extend([second_call, second_transfer]);
    activity.movements[0].x = RawTokenAmount(1_000);
    let mut second = activity.movements[0];
    second.at.top = 1;
    activity.movements.push(second);
    (wallet, tx, activity)
}

#[test]
fn two_gross_deposits_to_one_reserve_exclude_each_instructions_tax() {
    let (wallet, tx, activity) = two_deposits();
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    let deposits: Vec<_> = entries
        .iter()
        .filter(|entry| matches!(entry.kind, EntryKind::PositionDeposit { .. }))
        .map(|entry| entry.amount)
        .collect();
    assert_eq!(deposits, [-950, -950]);
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.kind == EntryKind::TransferFee)
            .map(|entry| entry.amount)
            .sum::<i128>(),
        -100
    );
    assert!(entries.iter().all(|entry| !matches!(
        entry.kind,
        EntryKind::ProtocolActivity { .. }
            | EntryKind::SwapIn
            | EntryKind::SwapOut
            | EntryKind::CapitalDeposit { .. }
            | EntryKind::CapitalWithdrawal { .. }
    )));
}

#[expect(
    clippy::indexing_slicing,
    clippy::unwrap_used,
    reason = "two known calls and their source movements form the fixture"
)]
fn nested_deposits() -> (WalletContext, TransactionView, TxActivity) {
    let (wallet, mut tx, mut activity) = two_deposits();
    let mut nodes = vec![instruction(address(42), vec![], vec![])];
    for (call_index, chunk) in tx.instructions.chunks(2).enumerate() {
        let inner = u16::try_from(call_index * 3).unwrap();
        let mut call = chunk[0].clone();
        call.position = InstructionPosition {
            top: 0,
            inner: Some(inner),
        };
        call.stack_height = Some(2);
        let mut transfer = chunk[1].clone();
        transfer.position = InstructionPosition {
            top: 0,
            inner: Some(inner + 1),
        };
        transfer.stack_height = Some(3);
        let mut event = instruction(
            binsight_dlmm::program::PROGRAM_ID,
            vec![],
            binsight_dlmm::program::EVENT_IX_TAG.to_vec(),
        );
        event.position = InstructionPosition {
            top: 0,
            inner: Some(inner + 2),
        };
        event.stack_height = Some(3);
        nodes.extend([call, transfer, event]);
        activity.movements[call_index].at = InstructionPosition {
            top: 0,
            inner: Some(inner + 2),
        };
    }
    tx.instructions = nodes;
    (wallet, tx, activity)
}

#[test]
fn nested_sibling_deposits_use_their_own_event_emitter_and_keep_net_events_intact() {
    let (wallet, tx, mut activity) = nested_deposits();
    activity.movements[0].x = RawTokenAmount(950);
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|entry| matches!(entry.kind, EntryKind::PositionDeposit { .. }))
            .map(|entry| entry.amount)
            .collect::<Vec<_>>(),
        [-950, -950]
    );
    assert!(
        entries
            .iter()
            .all(|entry| !matches!(entry.kind, EntryKind::ProtocolActivity { .. }))
    );
}

#[test]
fn refuses_to_allocate_an_aggregate_tax_between_two_gross_deposit_calls() {
    let (wallet, mut tx, activity) = two_deposits();
    for node in &mut tx.instructions {
        if node.program == TOKEN_2022_PROGRAM {
            let mut bytes = vec![12];
            bytes.extend(1_000_u64.to_le_bytes());
            bytes.push(6);
            node.data = binsight_solana::transaction::InstructionData(bytes);
        }
    }
    assert_eq!(
        book_transaction(&wallet, &tx, &activity),
        Err(binsight_ledger::book::BookError::UncertainTransferFee {
            account: address(3),
            mint: address(9)
        })
    );
}

#[test]
fn two_gross_sibling_calls_below_one_top_level_keep_their_transfer_tax_separate() {
    let (wallet, tx, activity) = nested_deposits();
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|entry| matches!(entry.kind, EntryKind::PositionDeposit { .. }))
            .map(|entry| entry.amount)
            .collect::<Vec<_>>(),
        [-950, -950]
    );
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.kind == EntryKind::TransferFee)
            .map(|entry| entry.amount)
            .sum::<i128>(),
        -100
    );
    assert!(
        entries
            .iter()
            .all(|entry| !matches!(entry.kind, EntryKind::ProtocolActivity { .. }))
    );
}

#[test]
fn refuses_a_gross_event_when_missing_stack_heights_prevent_proving_its_transfer() {
    let (wallet, mut tx, activity) = nested_deposits();
    tx.instructions[1].stack_height = None;
    assert_eq!(
        book_transaction(&wallet, &tx, &activity),
        Err(binsight_ledger::book::BookError::UncertainTransferFee {
            account: address(3),
            mint: address(9)
        })
    );
}
