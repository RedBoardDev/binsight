//! Transaction-local ownership and original activity-to-life associations for booking afterwards.

use std::collections::BTreeSet;

use binsight_solana::Address;

use super::{LifetimeDiagnostic, LifetimeError};
use crate::book::PositionActivitySource;
use crate::facts::PositionId;

/// Resolved ownership for this transaction, never a set of addresses owned forever.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TransactionOwnership {
    pub(super) positions: BTreeSet<Address>,
    pub(super) sources: Vec<(PositionActivitySource, PositionId)>,
    pub(super) diagnostics: Vec<LifetimeDiagnostic>,
    pub(super) unresolved: bool,
}

impl TransactionOwnership {
    /// The relevant owned addresses to pass to `WalletContext::positions` for this transaction.
    ///
    /// # Errors
    /// Returns [`LifetimeError::UnresolvedOwnership`] if necessary ownership is unknown. Do
    /// not book the transaction with an empty set instead; independent raw fee facts remain known.
    pub fn positions(&self) -> Result<&BTreeSet<Address>, LifetimeError> {
        if self.unresolved {
            return Err(LifetimeError::UnresolvedOwnership);
        }
        Ok(&self.positions)
    }

    /// The life of a row in the original unfiltered activity, including its instruction proof.
    /// A known foreign owner's row has no association; unresolved rows have a diagnostic too.
    pub fn position_for(&self, source: PositionActivitySource) -> Option<PositionId> {
        self.sources
            .iter()
            .find_map(|&(known, position)| (known == source).then_some(position))
    }

    /// Missing ownership or date/order evidence which must remain visible to downstream facts.
    pub fn diagnostics(&self) -> &[LifetimeDiagnostic] {
        &self.diagnostics
    }
}
