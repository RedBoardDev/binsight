//! How sure the sign of a position's PnL is when part of it has no price.
//!
//! An unpriced withdrawal, fee claim or reward only leaves value out: the known PnL is a lower
//! bound, so a positive one is a certain win. An unpriced deposit leaves a cost out: the known PnL
//! may be too high, so only a negative one is a certain loss. Open and closed positions share this
//! rule; it does not value anything.

use binsight_core::exactness::Exactness;

use super::Outcome;
use crate::facts::{QuoteUnits, UnpricedMovements};

/// Which way a position's true PnL may lie from its known PnL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PnlUncertainty {
    /// Something left out can only add: the known PnL is a lower bound.
    may_be_higher: bool,
    /// Something left out may be a cost: the known PnL may be too high.
    may_be_lower: bool,
}

impl PnlUncertainty {
    /// The uncertainty of a position with these unpriced movements and rewards.
    pub(crate) fn of(unpriced: UnpricedMovements, unpriced_rewards: u32) -> Self {
        Self {
            may_be_higher: unpriced.withdrawals > 0
                || unpriced.fee_claims > 0
                || unpriced_rewards > 0,
            may_be_lower: unpriced.deposits > 0,
        }
    }

    /// Estimated when a cost may be missing, a lower bound (partial) when only value is
    /// missing, complete otherwise.
    pub(crate) fn exactness(self) -> Exactness {
        if self.may_be_lower {
            Exactness::Estimated
        } else if self.may_be_higher {
            Exactness::Partial
        } else {
            Exactness::Complete
        }
    }

    /// The outcome of a known PnL: its sign when that sign is certain, unknown otherwise.
    pub(crate) fn outcome(self, pnl: QuoteUnits) -> Outcome {
        let known = Outcome::of(pnl);
        match (self.may_be_higher, self.may_be_lower) {
            (false, false) => known,
            (true, false) if known == Outcome::Win => known,
            (false, true) if known == Outcome::Loss => known,
            _ => Outcome::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unpriced(deposits: u32, withdrawals: u32, fee_claims: u32) -> UnpricedMovements {
        UnpricedMovements {
            deposits,
            withdrawals,
            fee_claims,
        }
    }

    #[test]
    fn keeps_a_certain_sign_and_hides_only_an_uncertain_one() {
        let cases = [
            (unpriced(0, 0, 0), 0, 5, Outcome::Win, Exactness::Complete),
            (unpriced(0, 0, 0), 0, 0, Outcome::Flat, Exactness::Complete),
            (unpriced(0, 0, 1), 0, 5, Outcome::Win, Exactness::Partial),
            (
                unpriced(0, 0, 1),
                0,
                0,
                Outcome::Unknown,
                Exactness::Partial,
            ),
            (
                unpriced(0, 1, 0),
                0,
                -5,
                Outcome::Unknown,
                Exactness::Partial,
            ),
            (
                unpriced(0, 0, 0),
                1,
                -5,
                Outcome::Unknown,
                Exactness::Partial,
            ),
            (
                unpriced(1, 0, 0),
                0,
                -5,
                Outcome::Loss,
                Exactness::Estimated,
            ),
            (
                unpriced(1, 0, 0),
                0,
                5,
                Outcome::Unknown,
                Exactness::Estimated,
            ),
            (
                unpriced(1, 0, 1),
                0,
                -5,
                Outcome::Unknown,
                Exactness::Estimated,
            ),
        ];
        for (movements, rewards, pnl, outcome, exactness) in cases {
            let uncertainty = PnlUncertainty::of(movements, rewards);
            assert_eq!(uncertainty.outcome(QuoteUnits(pnl)), outcome);
            assert_eq!(uncertainty.exactness(), exactness);
        }
    }
}
