//! Independently check that entries equal the actual wallet changes for every asset.
use super::real_deltas;
use super::{BookError, LedgerEntry, WalletContext};
use binsight_dlmm::activity::TxActivity;
use binsight_solana::transaction::TransactionView;
use std::collections::BTreeMap;

/// Checks conservation per asset, including rent even when its real change is zero.
///
/// # Errors
/// Returns [`BookError`] on overflow or an entry total inconsistent with the balances.
pub fn check(
    wallet: &WalletContext,
    tx: &TransactionView,
    activity: &TxActivity,
    entries: &[LedgerEntry],
) -> Result<(), BookError> {
    let owned = wallet.owned_positions(activity);
    let deltas = real_deltas::measure(wallet.wallet, &owned, tx)?;
    let mut remaining: BTreeMap<_, _> = deltas.per_asset()?.into_iter().collect();
    for entry in entries {
        let amount = remaining.entry(entry.asset).or_default();
        *amount = amount
            .checked_sub(entry.amount)
            .ok_or(BookError::Overflow)?;
    }
    match remaining.into_iter().find(|(_, amount)| *amount != 0) {
        Some((asset, _)) => Err(BookError::Invariant { asset }),
        None => Ok(()),
    }
}
