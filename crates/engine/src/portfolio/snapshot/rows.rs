//! The positions of a snapshot with their valuation, open or closed.

use binsight_ledger::facts::{ClosedPositionFacts, OpenPositionFacts, PositionId};
use binsight_ledger::report::closed::ClosedValuation;
use binsight_ledger::report::open::OpenValuation;
use binsight_solana::Address;

/// A closed position and its valuation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedRow {
    /// The facts.
    pub facts: ClosedPositionFacts,
    /// Its figures.
    pub valuation: ClosedValuation,
}

/// An open position and its valuation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenRow {
    /// The facts.
    pub facts: OpenPositionFacts,
    /// Its figures.
    pub valuation: OpenValuation,
}

/// A tracked position, open or closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PositionRow<'a> {
    /// Still open.
    Open(&'a OpenRow),
    /// Closed.
    Closed(&'a ClosedRow),
}

impl PositionRow<'_> {
    /// Its identity.
    pub fn id(self) -> PositionId {
        match self {
            Self::Open(row) => row.facts.id,
            Self::Closed(row) => row.facts.id,
        }
    }

    /// Its pool.
    pub fn pool(self) -> Address {
        match self {
            Self::Open(row) => row.facts.pool,
            Self::Closed(row) => row.facts.pool,
        }
    }
}
