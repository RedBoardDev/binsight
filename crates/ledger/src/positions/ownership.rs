//! Transaction-local ownership and original activity-to-life associations for booking afterwards.

use std::collections::BTreeSet;

use binsight_solana::Address;
use binsight_solana::transaction::InstructionPosition;

use super::{LifetimeDiagnostic, LifetimeError};
use crate::book::PositionActivitySource;
use crate::facts::PositionId;

/// The proved owner classification of one original activity row in this transaction.
///
/// Both variants retain its real creation identity. A foreign association requires a
/// known, open position with a matching pool; absence of an association never proves foreign.
/// This classification does not establish complete history or ownership in another transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PositionActivityOwnership {
    /// The position's owner is the replayed wallet.
    Owned(PositionId),
    /// The position's proved owner differs from the replayed wallet.
    Foreign(PositionId),
}

/// Resolved ownership for this transaction, never a set of addresses owned forever.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TransactionOwnership {
    pub(super) positions: BTreeSet<Address>,
    pub(super) sources: Vec<(PositionActivitySource, PositionActivityOwnership)>,
    pub(super) lifecycle_sources: Vec<(usize, InstructionPosition, PositionId)>,
    pub(super) diagnostics: Vec<LifetimeDiagnostic>,
    pub(super) unresolved: bool,
    pub(super) unknown_creations: BTreeSet<Address>,
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
    /// A known foreign owner's row returns `None`; unresolved rows retain a diagnostic too.
    pub fn position_for(&self, source: PositionActivitySource) -> Option<PositionId> {
        match self.association_for(source)? {
            PositionActivityOwnership::Owned(position) => Some(position),
            PositionActivityOwnership::Foreign(_) => None,
        }
    }

    /// The proved classification of this original vector row and instruction.
    ///
    /// `None` means no association for this exact reference, never a foreign position. Use
    /// the reference with its captured transaction; no signature is duplicated in this map.
    /// Missing dates, ordering evidence and unknown activity remain separate diagnostics.
    ///
    /// # Errors
    /// Returns [`LifetimeError::UnresolvedOwnership`] when necessary ownership or contiguous
    /// source evidence is missing. It cannot turn an unresolved row into a foreign one.
    pub fn source_ownership(
        &self,
        source: PositionActivitySource,
    ) -> Result<Option<PositionActivityOwnership>, LifetimeError> {
        self.positions()?;
        Ok(self.association_for(source))
    }

    fn association_for(&self, source: PositionActivitySource) -> Option<PositionActivityOwnership> {
        self.sources
            .iter()
            .find_map(|&(known, ownership)| (known == source).then_some(ownership))
    }

    /// The life of a lifecycle row in this transaction's original unfiltered vector.
    ///
    /// Both its original index and instruction must match. A known foreign row or unresolved
    /// creation has no association; unresolved evidence remains in [`Self::diagnostics`]. Use
    /// this mapping with its captured source, as exposed by the sealed booking bundle.
    pub fn position_for_lifecycle(
        &self,
        index: usize,
        at: InstructionPosition,
    ) -> Option<PositionId> {
        self.lifecycle_sources
            .iter()
            .find_map(|&(original, instruction, position)| {
                (original == index && instruction == at).then_some(position)
            })
    }

    /// Missing ownership or date/order evidence which must remain visible to downstream facts.
    pub fn diagnostics(&self) -> &[LifetimeDiagnostic] {
        &self.diagnostics
    }

    /// Positions whose creation is unknown but whose movements moved the wallet's own tokens in
    /// this transaction. They are booked as the wallet's, without a position identity, so their
    /// position figures stay partial.
    pub fn unknown_creations(&self) -> &BTreeSet<Address> {
        &self.unknown_creations
    }
}
