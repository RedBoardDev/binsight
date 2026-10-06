//! A position whose creation is not in the history counts as the wallet's only when its movement
//! moved the wallet's own tokens; its life then starts at that movement.
#[path = "common/fold.rs"]
mod common;

use binsight_core::exactness::Exactness;
use binsight_core::units::Decimals;
use binsight_dlmm::activity::{MovementKind, TxActivity};
use binsight_dlmm::program::{EVENT_AUTHORITY, EVENT_IX_TAG, PROGRAM_ID};
use binsight_ledger::book::{Asset, EntryKind};
use binsight_ledger::facts::{PositionHistory, QuoteUnits};
use binsight_ledger::report::closed::{Outcome, lp_pnl};
use binsight_solana::Address;
use binsight_solana::transaction::{InstructionNode, InstructionPosition, TransactionView};
use binsight_solana::well_known::{SYSTEM_PROGRAM, TOKEN_PROGRAM, WSOL_MINT};
use common::*;

/// The `remove_liquidity` discriminator, as explorers write it.
const REMOVE_LIQUIDITY: u64 = 0x5055_d148_18ce_b16c;

/// The reserves of the SOL pool, its token's first.
const RESERVES: [Address; 2] = [Address::from_bytes([5; 32]), Address::from_bytes([6; 32])];

fn placed(top: u16, inner: Option<u16>, mut node: InstructionNode) -> InstructionNode {
    node.position = InstructionPosition { top, inner };
    node.stack_height = Some(if inner.is_some() { 2 } else { 1 });
    node
}

/// A `remove_liquidity` call at `top` on `POSITION` that pays `lamports` of wrapped SOL from the
/// pool's reserve into `destination`, then emits its event.
#[expect(
    clippy::indexing_slicing,
    reason = "the remove_liquidity layout has nine known accounts"
)]
fn withdrawal_into(destination: Address, lamports: u64, top: u16) -> [InstructionNode; 3] {
    let mut accounts = vec![book::address(0); 9];
    accounts[0] = POSITION;
    accounts[1] = SOL_POOL;
    accounts[7] = TOKEN;
    accounts[8] = WSOL_MINT;
    let call = book::instruction(
        PROGRAM_ID,
        accounts,
        REMOVE_LIQUIDITY.to_be_bytes().to_vec(),
    );
    let mut pay = vec![3];
    pay.extend(lamports.to_le_bytes());
    let pay = book::instruction(TOKEN_PROGRAM, vec![RESERVES[1], destination, SOL_POOL], pay);
    let event = book::instruction(PROGRAM_ID, vec![EVENT_AUTHORITY], EVENT_IX_TAG.to_vec());
    [
        placed(top, None, call),
        placed(top, Some(0), pay),
        placed(top, Some(1), event),
    ]
}

fn reserves(withdrawn: u128) -> Vec<binsight_solana::transaction::TokenBalance> {
    let mut wrapped = book::token(RESERVES[1], SOL_POOL, WSOL_MINT, withdrawn, 0);
    wrapped.decimals = Decimals(9);
    vec![book::token(RESERVES[0], SOL_POOL, TOKEN, 0, 0), wrapped]
}

fn withdrawal_activity(top: u16) -> TxActivity {
    let mut withdrawal = movement(
        POSITION,
        SOL_POOL,
        MovementKind::Withdrawal,
        (0, 500),
        Some(0),
    );
    withdrawal.at = InstructionPosition {
        top,
        inner: Some(1),
    };
    TxActivity {
        movements: vec![withdrawal],
        ..TxActivity::default()
    }
}

/// The wallet withdraws 500 lamports of wrapped SOL into its own wrapped-SOL account.
fn into_the_wallets_account() -> (TransactionView, TxActivity) {
    let account = book::address(3);
    let mut tx = transaction(1, 10);
    tx.native_balances
        .push(book::native(account, 2_039_280, 2_039_280));
    tx.instructions.extend(withdrawal_into(account, 500, 0));
    tx.token_balances = reserves(500);
    let mut received = book::token(account, WALLET, WSOL_MINT, 0, 500);
    received.decimals = Decimals(9);
    tx.token_balances.push(received);
    (tx, withdrawal_activity(0))
}

/// The same withdrawal, into a wrapped-SOL account the transaction creates for the wallet and
/// closes again, so the account has no balance before or after.
fn into_an_ephemeral_account() -> (TransactionView, TxActivity) {
    let ephemeral = book::address(3);
    let mut tx = transaction(1, 10);
    if let Some(wallet) = tx.native_balances.first_mut() {
        wallet.post.0 = 995_500;
    }
    let mut create = 0_u32.to_le_bytes().to_vec();
    create.extend(2_039_280_u64.to_le_bytes());
    create.extend(165_u64.to_le_bytes());
    create.extend(TOKEN_PROGRAM.as_bytes());
    tx.instructions.extend([
        placed(
            0,
            None,
            book::instruction(SYSTEM_PROGRAM, vec![WALLET, ephemeral], create),
        ),
        placed(
            1,
            None,
            book::instruction(TOKEN_PROGRAM, vec![ephemeral, WSOL_MINT, WALLET], vec![1]),
        ),
    ]);
    tx.instructions.extend(withdrawal_into(ephemeral, 500, 2));
    tx.instructions.push(placed(
        3,
        None,
        book::instruction(TOKEN_PROGRAM, vec![ephemeral, WALLET, WALLET], vec![9]),
    ));
    tx.token_balances = reserves(500);
    tx.native_balances.push(book::native(ephemeral, 0, 0));
    (tx, withdrawal_activity(2))
}

#[expect(clippy::unwrap_used, reason = "the synthetic withdrawal books")]
fn fold_one(
    tx: &TransactionView,
    activity: &TxActivity,
) -> (
    Vec<(Asset, i128, EntryKind)>,
    binsight_ledger::positions::PositionFold,
) {
    let mut fold = fold();
    let folded = fold.book(tx, activity, &pools()).unwrap();
    let entries = folded
        .entries
        .iter()
        .map(|entry| (entry.asset, entry.amount, entry.kind))
        .collect();
    (entries, fold)
}

#[test]
fn starts_a_life_at_a_withdrawal_that_paid_the_wallet_when_its_creation_is_missing() {
    let (tx, activity) = into_the_wallets_account();
    let (entries, fold) = fold_one(&tx, &activity);
    assert!(entries.contains(&(
        Asset::Token { mint: WSOL_MINT },
        500,
        EntryKind::PositionWithdrawal { position: POSITION }
    )));
    let lives: Vec<_> = fold.open().collect();
    assert_eq!(lives.len(), 1);
    assert_eq!(lives[0].id.opened_by, tx.signature);
    assert_eq!(lives[0].opened_at, time(10));
    assert_eq!(lives[0].flows.withdrawn, QuoteUnits(500));
    assert_eq!(lives[0].history, PositionHistory::MissingCreation);
    assert_eq!(fold.diagnostics().missing_creations, 1);
}

/// The life started at a withdrawal of 500 lamports closes later: its known PnL is +500, but its
/// earlier deposits are not in the history, so the PnL is estimated and its sign unknown.
#[test]
fn marks_a_life_without_its_creation_estimated_with_an_unknown_outcome() {
    let (tx, activity) = into_the_wallets_account();
    let mut fold = fold();
    fold.book(&tx, &activity, &pools()).unwrap();
    let close = moves(Vec::new());
    let close = TxActivity {
        lifecycle: vec![closed(POSITION, WALLET)],
        ..close
    };
    let closed = fold
        .book(&step(2, 11, &close), &close, &pools())
        .unwrap()
        .closed;
    assert_eq!(closed[0].history, PositionHistory::MissingCreation);
    assert_eq!(lp_pnl(&closed[0]), Ok(QuoteUnits(500)));
    let valued = valued(&closed[0]);
    assert_eq!(valued.outcome, Outcome::Unknown);
    assert_eq!(valued.native_pnl.exactness(), Exactness::Estimated);
    assert_eq!(valued.withdrawn.exactness(), Exactness::Partial);
}

#[test]
fn counts_a_withdrawal_into_an_ephemeral_wrapped_sol_account_as_the_wallets() {
    let (tx, activity) = into_an_ephemeral_account();
    let (entries, fold) = fold_one(&tx, &activity);
    assert!(entries.contains(&(
        Asset::Token { mint: WSOL_MINT },
        500,
        EntryKind::PositionWithdrawal { position: POSITION }
    )));
    assert_eq!(
        fold.open()
            .map(|life| life.flows.withdrawn)
            .collect::<Vec<_>>(),
        [QuoteUnits(500)]
    );
}

#[test]
fn ignores_a_movement_of_an_unknown_position_that_paid_someone_else() {
    let mut tx = transaction(1, 10);
    tx.instructions
        .extend(withdrawal_into(book::address(4), 500, 0));
    tx.token_balances = reserves(500);
    let (entries, fold) = fold_one(&tx, &withdrawal_activity(0));
    assert!(
        entries
            .iter()
            .all(|(_, _, kind)| !matches!(kind, EntryKind::PositionWithdrawal { .. }))
    );
    assert_eq!(fold.open().count(), 0);
    assert_eq!(fold.diagnostics().missing_creations, 0);
}
