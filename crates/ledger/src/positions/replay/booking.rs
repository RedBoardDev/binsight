//! Seal the exact source replayed and booked before committing its ownership delta.

use super::{PositionLifetimes, delta, order};
use crate::book::{WalletContext, book_transaction};
use crate::positions::normalization::normalize;
use crate::positions::{BookedPositionTransaction, NormalizationError, PositionTransaction};

impl PositionLifetimes {
    /// Resolves ownership, books and normalizes this owned source as one atomic replay step.
    ///
    /// The returned bundle captures the exact source consumed here; no mutable source or
    /// caller-supplied entries can be substituted afterwards. Only the context's position
    /// addresses are replaced by replayed ownership; its tracked wallets and registries remain.
    /// Dates and ordering provenance stay optional, without manufacturing dated financial facts.
    ///
    /// # Errors
    /// Returns [`NormalizationError`] for unresolved or contradictory ownership, a wrong
    /// context wallet, booking failure or inconsistent position legs. Replay remains unchanged.
    pub fn book_and_apply(
        &mut self,
        source: PositionTransaction,
        mut context: WalletContext,
    ) -> Result<BookedPositionTransaction, NormalizationError> {
        if context.wallet != source.wallet {
            return Err(NormalizationError::WrongContextWallet);
        }
        let last = order::validate(self, &source)?;
        let delta = delta::TransactionDelta::build(self, &source)?;
        context.positions.clone_from(delta.ownership.positions()?);
        let entries = book_transaction(&context, &source.transaction, &source.activity)?;
        let activities = normalize(&source, &delta.ownership, &entries)?;
        let ownership = self.commit_delta(&source, last, delta);
        Ok(BookedPositionTransaction::new(
            source, ownership, entries, activities,
        ))
    }
}
