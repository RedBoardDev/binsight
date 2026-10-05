//! Synthetic source builders shared by immutable booking bundle tests.
use crate::common::*;
use binsight_core::units::RawTokenAmount;
use binsight_ledger::book::WalletContext;
use binsight_ledger::positions::{PositionLifetimes, PositionTransaction, TransactionOrderProof};
use binsight_solana::Signature;

#[expect(
    clippy::unwrap_used,
    reason = "the synthetic deposit builder has one movement"
)]
pub(crate) fn deposit() -> PositionTransaction {
    let (_, mut transaction, mut activity) = book::positions::deposit();
    transaction.signature = Signature::from_bytes([2; 64]);
    transaction.slot = 11;
    transaction.block_time = Some(time(11));
    activity.movements.first_mut().unwrap().x = RawTokenAmount(1_000);
    PositionTransaction {
        wallet: WALLET,
        transaction,
        activity,
        order: Some(TransactionOrderProof::Canonical { index: 0 }),
    }
}

#[expect(
    clippy::unwrap_used,
    reason = "the known synthetic opening books successfully"
)]
pub(crate) fn replay() -> PositionLifetimes {
    let mut replay = PositionLifetimes::new(context());
    replay
        .book_and_apply(opening(1, 10), WalletContext::new(WALLET))
        .unwrap();
    replay
}
