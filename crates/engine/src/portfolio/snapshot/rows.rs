//! The positions of a snapshot with their valuation, open or closed.

use binsight_core::ratio::{Percent, RatioError};
use binsight_ledger::facts::{ClosedPositionFacts, OpenPositionFacts, PositionId};
use binsight_ledger::report::closed::ClosedValuation;
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::open::OpenValuation;
use binsight_ledger::report::returns::daily_return;
use binsight_ledger::report::valued::{Currency, percent_of};
use binsight_solana::Address;

/// A closed position and its valuation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedRow {
    /// The facts.
    pub facts: ClosedPositionFacts,
    /// Its figures.
    pub valuation: ClosedValuation,
    returns_sol: ClosedReturns,
    returns_usd: ClosedReturns,
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

/// The return figures, calculated once for sorting and every row view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClosedReturns {
    /// PnL divided by invested.
    pub(crate) pnl_percent: Figure<Percent>,
    /// Claimed fees divided by invested.
    pub(crate) fees_percent: Figure<Percent>,
    /// PnL divided by invested, scaled to one day held.
    pub(crate) daily_return: Figure<Percent>,
}

impl ClosedRow {
    /// Prepares a position and its return figures for reads.
    pub(super) fn new(
        facts: ClosedPositionFacts,
        valuation: ClosedValuation,
    ) -> Result<Self, RatioError> {
        let keys = |currency| -> Result<ClosedReturns, RatioError> {
            Ok(ClosedReturns {
                pnl_percent: percent_of(&valuation.pnl, &valuation.invested, currency)?,
                fees_percent: percent_of(&valuation.claimed_fees, &valuation.invested, currency)?,
                daily_return: daily_return(
                    &valuation.pnl,
                    &valuation.invested,
                    valuation.held_seconds,
                    currency,
                )?,
            })
        };
        Ok(Self {
            returns_sol: keys(Currency::Sol)?,
            returns_usd: keys(Currency::Usd)?,
            facts,
            valuation,
        })
    }

    /// The return figures in the requested currency.
    pub(crate) fn returns(&self, currency: Currency) -> &ClosedReturns {
        match currency {
            Currency::Sol => &self.returns_sol,
            Currency::Usd => &self.returns_usd,
        }
    }
}
