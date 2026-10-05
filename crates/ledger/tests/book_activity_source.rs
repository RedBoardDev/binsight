//! Exact activity provenance survives booking, including a gross deposit fully withheld as tax.
#[path = "common/book.rs"]
mod common;

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::{MovementKind, RewardClaim};
use binsight_ledger::book::{
    Asset, BookError, EntryKind, PositionActivitySource, book_transaction,
};
use binsight_solana::transaction::{InstructionData, InstructionPosition, TxOutcome};
use common::positions::deposit;
use common::*;
use proptest::prelude::*;

#[expect(
    clippy::indexing_slicing,
    reason = "the deposit fixture contains a known reserve, movement and transfer"
)]
fn taxed_deposit(
    fee: u64,
) -> (
    binsight_ledger::book::WalletContext,
    binsight_solana::transaction::TransactionView,
    binsight_dlmm::activity::TxActivity,
) {
    let (wallet, mut tx, mut activity) = deposit();
    tx.token_balances[1].post = RawTokenAmount(u128::from(1_000 - fee));
    activity.movements[0].x = RawTokenAmount(1_000);
    let mut bytes = vec![26, 1];
    bytes.extend(1_000_u64.to_le_bytes());
    bytes.push(6);
    bytes.extend(fee.to_le_bytes());
    tx.instructions[1].data = InstructionData(bytes);
    (wallet, tx, activity)
}

#[test]
fn skips_unowned_movements_without_renumbering_the_owned_activity_source() {
    let (wallet, tx, mut activity) = deposit();
    let mut unrelated = activity.movements[0];
    unrelated.position = address(40);
    activity.movements.insert(0, unrelated);
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    let leg = entries.iter().find(|entry| entry.source.is_some()).unwrap();
    assert_eq!(leg.amount, -950);
    assert_eq!(
        leg.source,
        Some(PositionActivitySource::Movement {
            index: 1,
            at: activity.movements[1].at
        })
    );
    assert!(
        entries
            .iter()
            .filter(|entry| !matches!(entry.kind, EntryKind::PositionDeposit { .. }))
            .all(|entry| entry.source.is_none())
    );
}

#[test]
fn both_mints_of_one_movement_keep_the_same_source() {
    let (wallet, mut tx, mut activity) = deposit();
    tx.token_balances
        .push(token(address(5), wallet.wallet, address(8), 400, 0));
    tx.token_balances[2].post = RawTokenAmount(400);
    tx.native_balances.push(native(address(5), 200, 200));
    activity.movements[0].y = RawTokenAmount(400);
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    let legs: Vec<_> = entries
        .iter()
        .filter(|entry| entry.source.is_some())
        .collect();
    assert_eq!(legs.len(), 2);
    assert_eq!(legs[0].amount, -950);
    assert_eq!(legs[1].amount, -400);
    assert_eq!(legs[0].source, legs[1].source);
}

#[test]
fn retains_a_proven_zero_net_deposit_when_the_entire_gross_amount_is_taxed() {
    let (wallet, tx, activity) = taxed_deposit(1_000);
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    let position = entries
        .iter()
        .find(|entry| matches!(entry.kind, EntryKind::PositionDeposit { .. }))
        .unwrap();
    assert_eq!(position.amount, 0);
    assert_eq!(position.asset, Asset::Token { mint: address(9) });
    assert_eq!(
        position.source,
        Some(PositionActivitySource::Movement {
            index: 0,
            at: activity.movements[0].at
        })
    );
    assert!(
        entries
            .iter()
            .any(|entry| entry.kind == EntryKind::TransferFee
                && entry.amount == -1_000
                && entry.source.is_none())
    );
    assert_eq!(entries.len(), 3);
}

#[test]
fn omits_original_zero_movements_without_inventing_a_mint_or_source() {
    let (wallet, mut tx, mut activity) = deposit();
    tx.token_balances.clear();
    tx.instructions.clear();
    activity.movements[0].x = RawTokenAmount(0);
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert!(entries.iter().all(|entry| entry.source.is_none()));
    assert_eq!(entries.len(), 1);
}

#[test]
fn still_rejects_a_nonzero_movement_without_a_proven_mint() {
    let (wallet, mut tx, activity) = deposit();
    tx.token_balances.clear();
    tx.instructions.clear();
    assert_eq!(
        book_transaction(&wallet, &tx, &activity),
        Err(BookError::MissingMovementMint {
            position: address(11)
        })
    );
}

#[test]
fn does_not_apply_position_sources_from_a_failed_transaction() {
    let (wallet, mut tx, activity) = deposit();
    tx.outcome = TxOutcome::Failed {
        error: "synthetic failure".into(),
    };
    for balance in &mut tx.token_balances {
        balance.post = balance.pre;
    }
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind, EntryKind::FailedTxFee);
    assert!(entries[0].source.is_none());
}

#[test]
fn reward_source_indexes_the_original_activity_rows_instead_of_the_reward_slot() {
    let (wallet, mut tx, mut activity) = deposit();
    tx.instructions.clear();
    tx.token_balances[0].pre = RawTokenAmount(0);
    tx.token_balances[0].post = RawTokenAmount(20);
    tx.token_balances[1].pre = RawTokenAmount(20);
    tx.token_balances[1].post = RawTokenAmount(0);
    activity.movements.clear();
    let mut reward = RewardClaim {
        at: InstructionPosition {
            top: 2,
            inner: Some(3),
        },
        position: address(40),
        pool: address(12),
        reward_index: 0,
        mint: Some(address(9)),
        amount: RawTokenAmount(20),
    };
    activity.reward_claims.push(reward);
    reward.position = address(11);
    activity.reward_claims.push(reward);
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    let claim = entries
        .iter()
        .find(|entry| matches!(entry.kind, EntryKind::RewardClaim { .. }))
        .unwrap();
    assert_eq!(claim.amount, 20);
    assert_eq!(
        claim.source,
        Some(PositionActivitySource::RewardClaim {
            index: 1,
            at: reward.at
        })
    );
}

#[test]
fn preserves_distinct_sources_for_equal_withdrawal_and_redeposit_legs() {
    let (wallet, tx, mut activity) = deposit();
    let mut leg = activity.movements[0];
    leg.kind = MovementKind::RebalanceWithdrawal;
    leg.x = RawTokenAmount(300);
    leg.at = InstructionPosition {
        top: 4,
        inner: Some(2),
    };
    activity.movements.push(leg);
    leg.kind = MovementKind::RebalanceDeposit;
    leg.at.inner = Some(3);
    activity.movements.push(leg);
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    for (index, movement) in activity.movements.iter().enumerate() {
        let entry = entries
            .iter()
            .find(|entry| {
                entry.source
                    == Some(PositionActivitySource::Movement {
                        index,
                        at: movement.at,
                    })
            })
            .unwrap();
        assert_eq!(
            entry.amount,
            if index == 1 {
                300
            } else if index == 2 {
                -300
            } else {
                -950
            }
        );
    }
}

proptest! {
    #[test]
    fn conserves_every_gross_deposit_with_a_proven_fee_including_zero_net(fee in 0_u64..=1_000) {
        let (wallet, tx, activity) = taxed_deposit(fee);
        let entries = book_transaction(&wallet, &tx, &activity).unwrap();
        let leg = entries.iter().find(|entry| matches!(entry.kind, EntryKind::PositionDeposit { .. })).unwrap();
        prop_assert_eq!(leg.amount, -i128::from(1_000 - fee));
        prop_assert_eq!(leg.source, Some(PositionActivitySource::Movement { index: 0, at: activity.movements[0].at }));
        prop_assert_eq!(entries.iter().filter(|entry| entry.asset == Asset::Token { mint: address(9) }).map(|entry| entry.amount).sum::<i128>(), -1_000);
        prop_assert!(entries.iter().filter(|entry| entry.kind == EntryKind::TransferFee).all(|entry| entry.source.is_none()));
    }
}
