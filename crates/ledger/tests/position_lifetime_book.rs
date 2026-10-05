//! Transaction-local ownership joins the existing book without changing its NET or tax rules.
#[path = "common/lifetimes.rs"]
mod common;

use binsight_core::units::RawTokenAmount;
use binsight_ledger::book::{EntryKind, WalletContext, book_transaction};
use binsight_ledger::positions::{LifetimeError, PositionLifetimes, RawActivityEvidence};
use common::*;

#[test]
fn keeps_a_positive_gross_deposit_nonshell_when_the_proven_tax_leaves_zero_net() {
    let mut replay = PositionLifetimes::new(context());
    replay.apply(&opening(1, 10)).unwrap();
    let (_, mut transaction, mut activity) = book::positions::deposit();
    transaction.signature = binsight_solana::Signature::from_bytes([2; 64]);
    transaction.slot = 11;
    transaction.block_time = Some(time(11));
    activity.movements.first_mut().unwrap().x = RawTokenAmount(1_000);
    let [_, reserve, ..] = transaction.token_balances.as_mut_slice() else {
        panic!("the synthetic deposit has a reserve balance");
    };
    reserve.post = RawTokenAmount(0);
    let [_, transfer, ..] = transaction.instructions.as_mut_slice() else {
        panic!("the synthetic deposit has a transfer instruction");
    };
    let mut bytes = vec![26, 1];
    bytes.extend(1_000_u64.to_le_bytes());
    bytes.push(6);
    bytes.extend(1_000_u64.to_le_bytes());
    transfer.data = binsight_solana::transaction::InstructionData(bytes);
    let source = binsight_ledger::positions::PositionTransaction {
        wallet: WALLET,
        transaction,
        activity,
        order: Some(binsight_ledger::positions::TransactionOrderProof::Canonical { index: 0 }),
    };
    let ownership = replay.apply(&source).unwrap();
    let mut wallet = WalletContext::new(WALLET);
    wallet.positions = ownership.positions().unwrap().clone();
    let entries = book_transaction(&wallet, &source.transaction, &source.activity).unwrap();
    let deposit = entries
        .iter()
        .find(|entry| matches!(entry.kind, EntryKind::PositionDeposit { .. }))
        .unwrap();
    assert_eq!(deposit.amount, 0);
    assert_eq!(
        entries
            .iter()
            .find(|entry| entry.kind == EntryKind::TransferFee)
            .unwrap()
            .amount,
        -1_000
    );
    assert_eq!(
        ownership
            .position_for(deposit.source.unwrap())
            .unwrap()
            .address,
        POSITION
    );
    assert_eq!(
        replay.finish().lifetimes.first().unwrap().raw_activity,
        RawActivityEvidence::ObservedNonzero
    );
}

#[test]
fn refuses_foreign_wallet_sources_without_publishing_owned_addresses() {
    let mut replay = PositionLifetimes::new(context());
    let mut source = opening(1, 10);
    source.wallet = FOREIGN;
    assert_eq!(replay.apply(&source), Err(LifetimeError::WrongWallet));
    assert_eq!(replay.finish().lifetimes, Vec::new());
}

#[test]
fn refuses_duplicate_creation_and_contradictory_owner_without_closing_the_existing_life() {
    let mut replay = PositionLifetimes::new(context());
    replay.apply(&opening(1, 10)).unwrap();
    assert_eq!(
        replay.apply(&opening(2, 11)),
        Err(LifetimeError::DuplicateCreation { position: POSITION })
    );
    let mut close = closing(3, 12);
    close.activity.lifecycle.clear();
    close.activity.lifecycle.push(closed(0, FOREIGN));
    assert_eq!(
        replay.apply(&close),
        Err(LifetimeError::OwnerMismatch { position: POSITION })
    );
    assert!(replay.finish().lifetimes.first().unwrap().closed.is_none());
}

#[test]
fn keeps_positive_gross_evidence_even_without_contiguous_or_dated_history() {
    let mut context = context();
    context.sources_contiguous = false;
    let mut replay = PositionLifetimes::new(context);
    let mut source = opening(1, 10);
    source.transaction.block_time = None;
    source.activity.movements.push(movement(1, 1, 0));
    let ownership = replay.apply(&source).unwrap();
    assert_eq!(
        ownership.positions(),
        Err(LifetimeError::UnresolvedOwnership)
    );
    assert_eq!(
        replay.finish().lifetimes.first().unwrap().raw_activity,
        RawActivityEvidence::ObservedNonzero
    );
}

#[test]
fn refuses_to_close_an_already_closed_life_without_a_new_creation() {
    let mut replay = PositionLifetimes::new(context());
    replay.apply(&opening(1, 10)).unwrap();
    replay.apply(&closing(2, 11)).unwrap();
    assert_eq!(
        replay.apply(&closing(3, 12)),
        Err(LifetimeError::DuplicateClosure { position: POSITION })
    );
    assert_eq!(replay.finish().lifetimes.len(), 1);
}
