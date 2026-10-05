//! Synthetic raw booking bundles preserve NET capital and commit replay only after validation.
#[path = "common/lifetimes.rs"]
mod common;
#[path = "common/normalization.rs"]
mod normalization;

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::MovementKind;
use binsight_ledger::book::{BookError, Counterparty, EntryKind, WalletContext};
use binsight_ledger::positions::{
    LifetimeError, NormalizationError, NormalizedPositionActivity, PositionLifetimes,
    RawActivityEvidence, TransactionOrderProof,
};
use binsight_solana::{Signature, programs::TokenProgram};
use common::*;
use normalization::*;

#[test]
fn seals_original_gross_activity_with_net_deposit_and_separate_transfer_tax() {
    let mut replay = replay();
    let mut source = deposit();
    let original = source.clone();
    let bundle = replay
        .book_and_apply(source.clone(), WalletContext::new(WALLET))
        .unwrap();
    source.transaction.signature = Signature::from_bytes([99; 64]);
    source.activity.movements.clear();
    assert_eq!(bundle.source(), &original);
    let [
        NormalizedPositionActivity::Movement {
            position,
            source: origin,
            movement,
        },
    ] = bundle.activities()
    else {
        panic!("one synthetic movement")
    };
    assert_eq!(position.opened_by, Signature::from_bytes([1; 64]));
    assert_eq!(movement.x, RawTokenAmount(950));
    assert_eq!(movement.y, RawTokenAmount(0));
    let entry = bundle
        .entries()
        .iter()
        .find(|entry| matches!(entry.kind, EntryKind::PositionDeposit { .. }))
        .unwrap();
    assert_eq!(entry.source, Some(*origin));
    assert_eq!(entry.amount, -950);
    assert_eq!(
        bundle
            .entries()
            .iter()
            .find(|entry| entry.kind == EntryKind::TransferFee)
            .unwrap()
            .amount,
        -50
    );
    assert_eq!(
        bundle.source().activity.movements.first().unwrap().x,
        RawTokenAmount(1_000)
    );
}

#[test]
fn retains_a_zero_net_deposit_without_falling_back_to_positive_gross() {
    let mut replay = replay();
    let mut source = deposit();
    source.transaction.token_balances[1].post = RawTokenAmount(0);
    let transfer = &mut source.transaction.instructions[1];
    transfer.data.0.splice(11..19, 1_000_u64.to_le_bytes());
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    let [NormalizedPositionActivity::Movement { movement, .. }] = bundle.activities() else {
        panic!("one synthetic movement")
    };
    assert_eq!(movement.x, RawTokenAmount(0));
    assert_eq!(
        bundle
            .entries()
            .iter()
            .find(|entry| matches!(entry.kind, EntryKind::PositionDeposit { .. }))
            .unwrap()
            .amount,
        0
    );
    assert_eq!(
        replay.finish().lifetimes.first().unwrap().raw_activity,
        RawActivityEvidence::ObservedNonzero
    );
}

#[test]
fn leaves_replay_unchanged_after_booking_failure_and_accepts_the_corrected_signature() {
    let mut replay = PositionLifetimes::new(context());
    let mut broken = opening(1, 10);
    broken.activity.movements.push(movement(1, 1, 0));
    assert_eq!(
        replay.book_and_apply(broken, WalletContext::new(WALLET)),
        Err(NormalizationError::Book(BookError::MissingMovementMint {
            position: POSITION
        }))
    );
    let bundle = replay
        .book_and_apply(opening(1, 10), WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(bundle.activities(), []);
    let history = replay.finish();
    assert_eq!(history.lifetimes.len(), 1);
    assert_eq!(
        history.lifetimes.first().unwrap().raw_activity,
        RawActivityEvidence::ProvenEmpty
    );
    assert_eq!(history.diagnostics, Vec::new());
}

#[test]
fn refuses_unresolved_ownership_without_using_the_callers_permanent_position_set() {
    let mut replay = PositionLifetimes::new(context());
    let mut context = WalletContext::new(WALLET);
    context.positions.insert(POSITION);
    assert_eq!(
        replay.book_and_apply(deposit(), context),
        Err(NormalizationError::Lifetime(
            LifetimeError::UnresolvedOwnership
        ))
    );
    assert_eq!(replay.finish().lifetimes, Vec::new());
}

#[test]
fn rejects_a_context_wallet_mismatch_before_consuming_replay_order() {
    let mut replay = PositionLifetimes::new(context());
    assert_eq!(
        replay.book_and_apply(opening(1, 10), WalletContext::new(FOREIGN)),
        Err(NormalizationError::WrongContextWallet)
    );
    assert!(
        replay
            .book_and_apply(opening(1, 10), WalletContext::new(WALLET))
            .is_ok()
    );
}

#[test]
fn keeps_missing_dates_and_wallet_ordinals_explicit_without_financial_chain_order() {
    let mut replay = PositionLifetimes::new(context());
    let mut source = opening(1, 10);
    source.order = Some(TransactionOrderProof::WalletOrdinal { rank: 7 });
    source.transaction.transaction_index = None;
    source.transaction.block_time = None;
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(
        bundle.source().order,
        Some(TransactionOrderProof::WalletOrdinal { rank: 7 })
    );
    assert_eq!(bundle.source().transaction.transaction_index, None);
    assert_eq!(bundle.source().transaction.block_time, None);
    assert_ne!(bundle.ownership().diagnostics(), []);
    assert!(
        bundle
            .entries()
            .iter()
            .any(|entry| entry.kind == EntryKind::NetworkFee)
    );
}

#[test]
fn preserves_tracked_wallet_registry_while_replacing_only_local_position_ownership() {
    let mut replay = PositionLifetimes::new(context());
    let mut source = source(1, 10);
    source
        .transaction
        .instructions
        .push(book::transfer(WALLET, FOREIGN, 100));
    source
        .transaction
        .native_balances
        .first_mut()
        .unwrap()
        .post
        .0 -= 100;
    source
        .transaction
        .native_balances
        .push(book::native(FOREIGN, 0, 100));
    let mut context = WalletContext::new(WALLET);
    context.tracked_wallets.insert(FOREIGN);
    context.positions.insert(POSITION);
    let bundle = replay.book_and_apply(source, context).unwrap();
    assert!(bundle.ownership().positions().unwrap().is_empty());
    assert!(bundle.entries().iter().any(|entry| entry.kind
        == EntryKind::CapitalWithdrawal {
            counterparty: Counterparty::TrackedWallet(FOREIGN),
        }));
}

#[test]
fn retains_gross_withdrawal_and_its_metadata_without_quote_valuation() {
    let mut replay = replay();
    let mut source = deposit();
    source.activity.movements.first_mut().unwrap().kind = MovementKind::Withdrawal;
    // A synthetic gross payout plus withheld tax; the wallet receives 950 units.
    let wallet = source.transaction.token_balances.first_mut().unwrap();
    wallet.pre = RawTokenAmount(0);
    wallet.post = RawTokenAmount(950);
    let reserve = &mut source.transaction.token_balances[1];
    reserve.pre = RawTokenAmount(1_000);
    reserve.post = RawTokenAmount(0);
    let transfer = &mut source.transaction.instructions[1];
    transfer.accounts.swap(0, 2);
    transfer.accounts[3] = POOL;
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    let [NormalizedPositionActivity::Movement { movement, .. }] = bundle.activities() else {
        panic!("one synthetic movement")
    };
    assert_eq!(movement.x, RawTokenAmount(1_000));
    assert_eq!(movement.price_bin, Some(0));
    assert_eq!(
        bundle
            .entries()
            .iter()
            .find(|entry| entry.kind == EntryKind::TransferFee)
            .unwrap()
            .amount,
        -50
    );
}

#[test]
fn rejects_duplicate_source_mints_atomically_then_books_the_same_signature_corrected() {
    let mut replay = replay();
    let mut broken = deposit();
    let mint = book::address(9);
    let change = broken.activity.movements.first_mut().unwrap();
    change.x = RawTokenAmount(500);
    change.y = RawTokenAmount(500);
    for balance in &mut broken.transaction.token_balances {
        balance.program = TokenProgram::Token;
        if balance.owner_pre == Some(POOL) {
            balance.mint = mint;
        }
    }
    broken.transaction.token_balances[1].post = RawTokenAmount(1_000);
    broken
        .transaction
        .instructions
        .first_mut()
        .unwrap()
        .accounts[8] = mint;
    let transfer = &mut broken.transaction.instructions[1];
    transfer.program = binsight_solana::well_known::TOKEN_PROGRAM;
    transfer.data.0 = vec![12];
    transfer.data.0.extend(1_000_u64.to_le_bytes());
    transfer.data.0.push(6);
    assert_eq!(
        replay.book_and_apply(broken, WalletContext::new(WALLET)),
        Err(NormalizationError::DuplicateLeg)
    );
    assert!(
        replay
            .book_and_apply(deposit(), WalletContext::new(WALLET))
            .is_ok()
    );
    assert_eq!(replay.finish().lifetimes.len(), 1);
}
