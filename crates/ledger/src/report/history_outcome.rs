//! How History files a closed position for its outcome filter: a clear win, a clear loss, or
//! flat.
//!
//! A position whose PnL is under a hundredth of a SOL either way moved too little to read as a
//! win or a loss, and an empty shell never moved at all: both are flat, which History hides by
//! default. This is a filter of the History screen only: totals keep counting wins, losses and
//! breakeven positions on the exact sign of the PnL (see [`super::closed::Outcome`]).

use super::closed::{ClosedValuation, Outcome};

/// Under this absolute PnL, in lamports (a hundredth of a SOL), a closed position is flat.
pub const FLAT_PNL_LAMPORTS: i128 = 10_000_000;

/// How History files a closed position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum HistoryOutcome {
    /// It gained a hundredth of a SOL or more.
    Win,
    /// It lost a hundredth of a SOL or more.
    Loss,
    /// It moved less than a hundredth of a SOL either way, or never moved (an empty shell).
    Flat,
}

impl HistoryOutcome {
    /// How History files the position valued as `valuation`. Its PnL in SOL decides; when the
    /// SOL value is unknown (a dollar pool without a rate), the sign of its PnL does.
    pub fn of(valuation: &ClosedValuation) -> Self {
        if valuation.is_shell {
            return Self::Flat;
        }
        let is_small = valuation
            .pnl
            .value()
            .is_some_and(|pnl| pnl.sol.0.unsigned_abs() < FLAT_PNL_LAMPORTS.unsigned_abs());
        match valuation.outcome {
            _ if is_small => Self::Flat,
            Outcome::Win => Self::Win,
            Outcome::Loss => Self::Loss,
            Outcome::Breakeven => Self::Flat,
        }
    }
}

#[cfg(test)]
mod tests {
    use binsight_core::money::SignedLamports;

    use super::*;
    use crate::report::figure::Figure;
    use crate::report::valued::Valued;

    fn valuation(pnl_lamports: i128, outcome: Outcome) -> ClosedValuation {
        let pnl = Figure::Complete(Valued {
            sol: SignedLamports(pnl_lamports),
            usd: None,
        });
        ClosedValuation {
            invested: pnl.clone(),
            withdrawn: pnl.clone(),
            claimed_fees: pnl.clone(),
            lp_pnl: pnl.clone(),
            market_pnl: None,
            pnl,
            outcome,
            held_seconds: 60,
            is_shell: false,
        }
    }

    #[test]
    fn files_a_clear_win_and_a_clear_loss_by_their_sign() {
        assert_eq!(
            HistoryOutcome::of(&valuation(10_000_000, Outcome::Win)),
            HistoryOutcome::Win
        );
        assert_eq!(
            HistoryOutcome::of(&valuation(-10_000_000, Outcome::Loss)),
            HistoryOutcome::Loss
        );
    }

    #[test]
    fn files_a_pnl_under_a_hundredth_of_a_sol_as_flat() {
        assert_eq!(
            HistoryOutcome::of(&valuation(9_999_999, Outcome::Win)),
            HistoryOutcome::Flat
        );
        assert_eq!(
            HistoryOutcome::of(&valuation(-9_999_999, Outcome::Loss)),
            HistoryOutcome::Flat
        );
        assert_eq!(
            HistoryOutcome::of(&valuation(0, Outcome::Breakeven)),
            HistoryOutcome::Flat
        );
    }

    #[test]
    fn files_an_empty_shell_as_flat() {
        let mut shell = valuation(0, Outcome::Breakeven);
        shell.is_shell = true;

        assert_eq!(HistoryOutcome::of(&shell), HistoryOutcome::Flat);
    }
}
