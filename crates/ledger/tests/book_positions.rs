//! Position flows remain separate from swaps and fees withheld on Token-2022 transfers.
mod common;
use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::{MovementKind, TxActivity};
use binsight_ledger::book::{Asset, EntryKind, WalletContext, book_transaction};
use binsight_solana::transaction::InstructionPosition;
use binsight_solana::well_known::TOKEN_2022_PROGRAM;
use common::positions::deposit;
use common::*;

#[test]
fn books_the_token_2022_fee_of_a_deposit_as_a_transfer_fee() {
    let (wallet, tx, activity) = deposit();
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert!(
        entries
            .iter()
            .any(|entry| entry.kind == EntryKind::TransferFee && entry.amount == -50)
    );
    assert!(entries.iter().any(
        |entry| matches!(entry.kind, EntryKind::PositionDeposit { .. }) && entry.amount == -950
    ));
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.asset == Asset::Token { mint: address(9) })
            .map(|entry| entry.amount)
            .sum::<i128>(),
        -1_000
    );
    assert!(entries.iter().all(|entry| !matches!(
        entry.kind,
        EntryKind::ProtocolActivity { .. } | EntryKind::CapitalWithdrawal { .. }
    )));
}

#[test]
fn infers_a_token_2022_fee_from_a_single_checked_transfer_and_its_net_receipt() {
    let (wallet, mut tx, activity) = deposit();
    let mut bytes = vec![12];
    bytes.extend(1_000_u64.to_le_bytes());
    bytes.push(6);
    tx.instructions[1].data = binsight_solana::transaction::InstructionData(bytes);
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert!(
        entries
            .iter()
            .any(|entry| entry.kind == EntryKind::TransferFee && entry.amount == -50)
    );
    assert_eq!(entries.len(), 3);
}

#[test]
fn never_reads_a_dlmm_withdrawal_as_a_buy() {
    let (wallet, mut tx, mut activity) = deposit();
    tx.token_balances[0].pre = RawTokenAmount(0);
    tx.token_balances[0].post = RawTokenAmount(950);
    tx.token_balances[1].pre = RawTokenAmount(1_000);
    tx.token_balances[1].post = RawTokenAmount(0);
    tx.instructions[1].accounts = vec![address(3), address(9), address(2), address(12)];
    activity.movements[0].kind = MovementKind::Withdrawal;
    activity.movements[0].x = RawTokenAmount(1_000);
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert!(entries.iter().any(
        |entry| matches!(entry.kind, EntryKind::PositionWithdrawal { .. }) && entry.amount == 1_000
    ));
    assert!(entries.iter().all(|entry| !matches!(
        entry.kind,
        EntryKind::SwapIn | EntryKind::SwapOut | EntryKind::ProtocolActivity { .. }
    )));
}

#[test]
fn releases_the_rent_of_a_closed_position_as_rent_not_capital() {
    let mut tx = transaction(10_000, 5_100);
    let position = address(11);
    tx.native_balances.push(native(position, 100, 0));
    let mut wallet = WalletContext::new(address(1));
    wallet.positions.insert(position);
    let entries = book_transaction(&wallet, &tx, &TxActivity::default()).unwrap();
    assert!(
        entries
            .iter()
            .any(|entry| entry.asset == Asset::Rent && entry.amount == -100)
    );
    assert!(entries.iter().any(|entry| entry.asset == Asset::Sol
        && matches!(entry.kind, EntryKind::RentRelease { .. })
        && entry.amount == 100));
    assert!(entries.iter().all(|entry| !matches!(
        entry.kind,
        EntryKind::CapitalDeposit { .. } | EntryKind::CapitalWithdrawal { .. }
    )));
}

#[test]
fn removes_the_tax_from_a_deposit_event_that_reports_the_gross_transfer() {
    let (wallet, tx, mut activity) = deposit();
    activity.movements[0].x = RawTokenAmount(1_000);
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert!(entries.iter().any(
        |entry| matches!(entry.kind, EntryKind::PositionDeposit { .. }) && entry.amount == -950
    ));
    assert!(
        entries
            .iter()
            .any(|entry| entry.kind == EntryKind::TransferFee && entry.amount == -50)
    );
    assert_eq!(entries.len(), 3);
}

#[test]
fn combines_a_withdrawal_and_multiple_claims_before_inferring_the_withheld_fee() {
    let (wallet, mut tx, mut activity) = deposit();
    tx.token_balances[0].pre = RawTokenAmount(0);
    tx.token_balances[0].post = RawTokenAmount(950);
    tx.token_balances[1].pre = RawTokenAmount(1_000);
    tx.token_balances[1].post = RawTokenAmount(0);
    tx.instructions.truncate(1);
    for amount in [700_u64, 200, 100] {
        let mut bytes = vec![12];
        bytes.extend(amount.to_le_bytes());
        bytes.push(6);
        tx.instructions.push(instruction(
            TOKEN_2022_PROGRAM,
            vec![address(3), address(9), address(2), address(12)],
            bytes,
        ));
    }
    let mut withdrawal = activity.movements[0];
    withdrawal.kind = MovementKind::Withdrawal;
    withdrawal.x = RawTokenAmount(700);
    let mut claim = withdrawal;
    claim.kind = MovementKind::FeeClaim;
    claim.x = RawTokenAmount(200);
    let mut other_claim = claim;
    other_claim.x = RawTokenAmount(100);
    activity.movements = vec![withdrawal, claim, other_claim];
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert!(
        entries
            .iter()
            .any(|entry| entry.kind == EntryKind::TransferFee && entry.amount == -50)
    );
    assert!(entries.iter().all(|entry| !matches!(
        entry.kind,
        EntryKind::ProtocolActivity { .. } | EntryKind::SwapIn | EntryKind::SwapOut
    )));
}

#[test]
fn adjusts_only_the_gross_deposit_and_keeps_a_second_deposit_of_the_same_position_intact() {
    let (wallet, tx, mut activity) = deposit();
    activity.movements[0].x = RawTokenAmount(1_000);
    let mut withdrawal = activity.movements[0];
    withdrawal.kind = MovementKind::RebalanceWithdrawal;
    withdrawal.x = RawTokenAmount(300);
    let mut redeposit = withdrawal;
    redeposit.kind = MovementKind::RebalanceDeposit;
    activity.movements.extend([withdrawal, redeposit]);
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    let deposits: Vec<_> = entries
        .iter()
        .filter(|entry| matches!(entry.kind, EntryKind::PositionDeposit { .. }))
        .map(|entry| entry.amount)
        .collect();
    assert_eq!(deposits, [-950, -300]);
    assert!(entries.iter().all(|entry| !matches!(
        entry.kind,
        EntryKind::ProtocolActivity { .. } | EntryKind::SwapIn | EntryKind::SwapOut
    )));
}

#[test]
fn a_reward_in_a_third_mint_and_its_transfer_fee_are_not_capital_or_swap_fees() {
    let (wallet, mut tx, mut activity) = deposit();
    tx.token_balances[0].pre = RawTokenAmount(0);
    tx.token_balances[0].post = RawTokenAmount(950);
    tx.token_balances[1].pre = RawTokenAmount(1_000);
    tx.token_balances[1].post = RawTokenAmount(0);
    tx.instructions[1].accounts = vec![address(3), address(9), address(2), address(12)];
    for balance in &mut tx.token_balances {
        if balance.mint == address(9) {
            balance.mint = address(7);
        }
    }
    tx.instructions[1].accounts[1] = address(7);
    activity.movements.clear();
    activity
        .reward_claims
        .push(binsight_dlmm::activity::RewardClaim {
            at: InstructionPosition {
                top: 0,
                inner: None,
            },
            position: address(11),
            pool: address(12),
            reward_index: 1,
            mint: Some(address(7)),
            amount: RawTokenAmount(1_000),
        });
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert!(entries.iter().any(|entry| entry.amount == 1_000
        && entry.kind
            == EntryKind::RewardClaim {
                position: address(11)
            }));
    assert!(
        entries
            .iter()
            .any(|entry| entry.amount == -50 && entry.kind == EntryKind::TransferFee)
    );
    assert!(entries.iter().all(|entry| !matches!(
        entry.kind,
        EntryKind::FeeClaim { .. }
            | EntryKind::ProtocolActivity { .. }
            | EntryKind::CapitalDeposit { .. }
            | EntryKind::SwapIn
            | EntryKind::SwapOut
    )));
}
