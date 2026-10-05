//! Builds one immutable wallet history from the snapshot's positions, entries and marks.

use binsight_core::error::AmountError;
use binsight_ledger::facts::{OpenPnlMark, WalletEntry};
use binsight_ledger::report::real_pnl::{WalletHistory, WalletHistoryFacts};

use super::{Snapshot, TrackedWallet};

/// Indexes the history of `wallet`.
pub(super) fn wallet_history(
    wallet: &TrackedWallet,
    snapshot: &Snapshot,
    marks: &[OpenPnlMark],
) -> Result<WalletHistory, AmountError> {
    let address = wallet.facts.address;
    let closed: Vec<_> = snapshot
        .closed
        .iter()
        .filter(|row| row.facts.wallet == address)
        .map(|row| (&row.facts, &row.valuation))
        .collect();
    let entries: Vec<&WalletEntry> = snapshot
        .entries
        .iter()
        .filter(|entry| entry.wallet == address)
        .collect();
    let marks: Vec<OpenPnlMark> = marks
        .iter()
        .filter(|mark| mark.wallet == address)
        .cloned()
        .collect();
    let open: Vec<_> = snapshot
        .open
        .iter()
        .filter(|row| row.facts.wallet == address)
        .map(|row| &row.facts)
        .collect();
    WalletHistory::new(WalletHistoryFacts {
        wallet: &wallet.facts,
        closed: &closed,
        open: &open,
        entries: &entries,
        marks: &marks,
        rates: &snapshot.rates,
    })
}
