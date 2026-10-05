//! Normalized raw activity sealed with the exact replayed transaction and conserved book.
//!
//! Deposits carry proven net units; withdrawals and claims retain gross units, with transfer
//! costs in the separate book. Raw quotation is a separate, explicitly selected pool boundary;
//! neither boundary creates dated facts, currency conversions or net accounting totals.

mod legs;
mod valuation;

pub use valuation::{QuotedPositionTransaction, SelectedPoolMovement, ValuationError};

use binsight_dlmm::activity::{PositionMovement, RewardClaim};

use super::{LifetimeError, PositionTransaction, TransactionOwnership};
use crate::book::{BookError, LedgerEntry, PositionActivitySource};
use crate::facts::PositionId;

pub(super) use legs::normalize;

/// One owned activity with normalized raw legs and its original vector/instruction identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NormalizedPositionActivity {
    /// A pool movement; physical X/Y stay unchanged, with deposits normalized to net amounts.
    Movement {
        /// Its row in the original, unfiltered activity.
        source: PositionActivitySource,
        /// Its replayed lifetime.
        position: PositionId,
        /// Its original metadata and normalized raw X/Y amounts.
        movement: PositionMovement,
    },
    /// A reward in its own mint, never priced by the pool bin.
    RewardClaim {
        /// Its row, distinct from the reward program's index.
        source: PositionActivitySource,
        /// Its replayed lifetime.
        position: PositionId,
        /// Its original reward metadata and normalized raw amount.
        reward: RewardClaim,
    },
}

/// A transaction successfully replayed, booked and normalized from the same captured source.
///
/// Only [`super::PositionLifetimes::book_and_apply`] constructs this bundle. Getters expose
/// immutable references; missing dates, explicit ordering tags and diagnostics remain intact.
/// Activity order follows original vectors, not a fabricated chronological or financial order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookedPositionTransaction {
    source: PositionTransaction,
    ownership: TransactionOwnership,
    entries: Vec<LedgerEntry>,
    activities: Vec<NormalizedPositionActivity>,
}

impl BookedPositionTransaction {
    pub(super) fn new(
        source: PositionTransaction,
        ownership: TransactionOwnership,
        entries: Vec<LedgerEntry>,
        activities: Vec<NormalizedPositionActivity>,
    ) -> Self {
        Self {
            source,
            ownership,
            entries,
            activities,
        }
    }

    /// The exact original source consumed by replay and booking, including gross activity.
    pub fn source(&self) -> &PositionTransaction {
        &self.source
    }

    /// Transaction-local ownership and retained diagnostics.
    pub fn ownership(&self) -> &TransactionOwnership {
        &self.ownership
    }

    /// The unchanged conserved book, including independent fees and transfer taxes.
    pub fn entries(&self) -> &[LedgerEntry] {
        &self.entries
    }

    /// Owned activities with raw net/gross legs, before valuation or rebalance netting.
    pub fn activities(&self) -> &[NormalizedPositionActivity] {
        &self.activities
    }
}

/// The source cannot be replayed and normalized without inventing position facts.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NormalizationError {
    /// The booking context belongs to another wallet.
    #[error("the booking context belongs to another wallet")]
    WrongContextWallet,
    /// Ownership or source order could not be resolved consistently.
    #[error(transparent)]
    Lifetime(#[from] LifetimeError),
    /// The existing accounting rules refused the transaction.
    #[error(transparent)]
    Book(#[from] BookError),
    /// A position book leg did not match its original activity and resolved mint.
    #[error("a position book leg does not match its activity source")]
    InvalidLeg,
    /// A nonzero original movement had no proven normalized leg.
    #[error("a nonzero position activity has no normalized book leg")]
    MissingLeg,
    /// One source and mint were recorded more than once.
    #[error("a position source has duplicate normalized book legs")]
    DuplicateLeg,
}
