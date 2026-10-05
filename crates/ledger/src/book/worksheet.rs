//! The working state of the booking of one transaction: the entries so far, and what is left to
//! explain in each asset.
//!
//! The worksheet starts from the real change of every asset. Each booked entry is subtracted from
//! the residue of its asset, so whatever the steps book, the entries plus the residues always add
//! up to the real change; the last step books the residues themselves. This module keeps the
//! accounts; it does not decide what to book.

use super::BookError;
use super::entry::{Asset, EntryKind, LedgerEntry};

/// The entries booked so far and the residue of every asset.
pub(super) struct Worksheet {
    /// What is left to explain, per asset, sorted by asset.
    residues: Vec<(Asset, i128)>,
    /// The entries, in booking order.
    entries: Vec<LedgerEntry>,
}

impl Worksheet {
    /// A worksheet with nothing explained yet in `changes` (each asset at most once).
    pub(super) fn new(mut changes: Vec<(Asset, i128)>) -> Self {
        changes.sort_unstable_by_key(|&(asset, _)| asset);
        Self {
            residues: changes,
            entries: Vec::with_capacity(8),
        }
    }

    /// Books `amount` of `asset` as `kind`, and leaves the rest of the asset to explain. A zero
    /// amount books nothing.
    pub(super) fn book(
        &mut self,
        asset: Asset,
        amount: i128,
        kind: EntryKind,
    ) -> Result<(), BookError> {
        if amount == 0 {
            return Ok(());
        }
        let residue = match self
            .residues
            .binary_search_by_key(&asset, |&(known, _)| known)
        {
            Ok(index) => self.residues.get_mut(index).map(|(_, residue)| residue),
            Err(index) => {
                self.residues.insert(index, (asset, 0));
                self.residues.get_mut(index).map(|(_, residue)| residue)
            }
        };
        let residue = residue.ok_or(BookError::Overflow)?;
        *residue = residue.checked_sub(amount).ok_or(BookError::Overflow)?;
        self.entries.push(LedgerEntry {
            asset,
            amount,
            kind,
        });
        Ok(())
    }

    /// Every asset with something left to explain, in asset order.
    pub(super) fn residues(&self) -> Vec<(Asset, i128)> {
        self.residues
            .iter()
            .copied()
            .filter(|&(_, residue)| residue != 0)
            .collect()
    }

    /// The entries booked.
    pub(super) fn into_entries(self) -> Vec<LedgerEntry> {
        self.entries
    }
}
