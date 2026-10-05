//! Validate monotonic source order without comparing canonical indices with listing ranks.

use binsight_dlmm::activity::TxActivity;
use binsight_solana::transaction::TxOutcome;

use super::PositionLifetimes;
use crate::positions::{LifetimeError, PositionTransaction, TransactionOrderProof};

#[derive(Debug, Clone, Copy)]
pub(super) struct LastTransaction {
    slot: u64,
    order: Option<TransactionOrderProof>,
    last_canonical: Option<u32>,
}

pub(super) fn validate(
    replay: &PositionLifetimes,
    source: &PositionTransaction,
) -> Result<LastTransaction, LifetimeError> {
    let tx = &source.transaction;
    if source.wallet != replay.context.wallet {
        return Err(LifetimeError::WrongWallet);
    }
    if replay.seen_transactions.contains(&tx.signature) {
        return Err(LifetimeError::DuplicateTransaction {
            signature: tx.signature,
        });
    }
    if let Some(TransactionOrderProof::Canonical { index }) = source.order
        && tx.transaction_index != Some(index)
    {
        return Err(LifetimeError::CanonicalIndexMismatch);
    }
    if tx.outcome != TxOutcome::Succeeded && source.activity != TxActivity::default() {
        return Err(LifetimeError::FailedTransactionActivity);
    }
    let mut last = LastTransaction {
        slot: tx.slot,
        order: source.order,
        last_canonical: tx.transaction_index,
    };
    if let Some(previous) = replay.last {
        if tx.slot < previous.slot {
            return Err(LifetimeError::UnorderedSources);
        }
        if tx.slot == previous.slot {
            validate_same_slot(previous, source)?;
            last.last_canonical = tx.transaction_index.or(previous.last_canonical);
        }
    }
    Ok(last)
}

fn validate_same_slot(
    previous: LastTransaction,
    source: &PositionTransaction,
) -> Result<(), LifetimeError> {
    let ordered = match (previous.order, source.order) {
        (
            Some(TransactionOrderProof::Canonical { index: before }),
            Some(TransactionOrderProof::Canonical { index: after }),
        ) => before < after,
        (
            Some(TransactionOrderProof::WalletOrdinal { rank: before }),
            Some(TransactionOrderProof::WalletOrdinal { rank: after }),
        ) => before > after,
        _ => return Err(LifetimeError::AmbiguousTransactionOrder),
    };
    if !ordered {
        return Err(LifetimeError::UnorderedSources);
    }
    if let (Some(before), Some(after)) = (
        previous.last_canonical,
        source.transaction.transaction_index,
    ) && before >= after
    {
        return Err(LifetimeError::UnorderedSources);
    }
    Ok(())
}
