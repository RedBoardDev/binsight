//! The totals of a set of closed positions: counts, win rate, sums and holding times.
//!
//! One rule serves every place that totals closed positions (today's figures, the recent closes,
//! history, stats, the calendar), so they always agree. The win rate leaves flat and unknown
//! positions out: `wins / (wins + losses)`. The PnL percentage is `Σ PnL / Σ invested`. Every
//! closed position counts, empty shells included (they are flat) and unknown outcomes included
//! (they are counted apart): the caller only decides which positions are in the set by its
//! filters, never by a rule of its own.

use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use binsight_core::ratio::{Percent, RatioError};

use super::closed::{ClosedValuation, Outcome};
use super::figure::{Figure, Reason, Reasons};
use super::valued::{Currency, Valued, percent_of, sum_valued};

/// The totals of a set of closed positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedTotals {
    /// How many positions.
    pub count: usize,
    /// How many gained.
    pub wins: usize,
    /// How many lost.
    pub losses: usize,
    /// How many ended flat: exactly even, or empty shells.
    pub flat: usize,
    /// How many have an unknown outcome (an unpriced movement or reward hides its sign).
    pub unknown: usize,
    /// `wins / (wins + losses)`; unavailable without a win or a loss.
    pub win_rate: Figure<Percent>,
    /// The sum of the PnL.
    pub pnl: Figure<Valued>,
    /// The sum of the claimed fees.
    pub fees: Figure<Valued>,
    /// The sum of farming rewards, separately from fees.
    pub rewards: Figure<Valued>,
    /// The sum invested.
    pub invested: Figure<Valued>,
    /// The sum withdrawn.
    pub withdrawn: Figure<Valued>,
    /// The mean holding time in whole seconds; `None` for an empty set.
    pub average_held_seconds: Option<i64>,
    /// The median holding time in whole seconds; `None` for an empty set.
    pub median_held_seconds: Option<i64>,
}

impl ClosedTotals {
    /// The totals of `positions`.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a sum overflows.
    pub fn of<'a>(
        positions: impl IntoIterator<Item = &'a ClosedValuation>,
    ) -> Result<Self, AmountError> {
        let positions: Vec<&ClosedValuation> = positions.into_iter().collect();
        let count_of = |outcome: Outcome| {
            positions
                .iter()
                .filter(|position| position.outcome == outcome)
                .count()
        };
        let (wins, losses) = (count_of(Outcome::Win), count_of(Outcome::Loss));
        let sum = |field: fn(&ClosedValuation) -> &Figure<Valued>| {
            sum_valued(positions.iter().map(|position| field(position).clone()))
        };
        let mut held: Vec<i64> = positions
            .iter()
            .map(|position| position.held_seconds)
            .collect();
        held.sort_unstable();
        Ok(Self {
            count: positions.len(),
            wins,
            losses,
            flat: count_of(Outcome::Flat),
            unknown: count_of(Outcome::Unknown),
            win_rate: win_rate(wins, losses),
            pnl: sum(|position| &position.pnl)?,
            fees: sum(|position| &position.claimed_fees)?,
            rewards: sum(|position| &position.rewards)?,
            invested: sum(|position| &position.invested)?,
            withdrawn: sum(|position| &position.withdrawn)?,
            average_held_seconds: average(&held),
            median_held_seconds: median(&held),
        })
    }

    /// Makes the period figures unavailable when its history is not covered.
    /// Counts still describe the observed rows; holding-time aggregates have no value.
    #[must_use]
    pub fn with_history(mut self, reasons: Reasons) -> Self {
        if reasons.is_empty() {
            return self;
        }
        let unavailable = Exactness::Unavailable;
        self.win_rate = self.win_rate.degraded(unavailable, reasons.clone());
        self.pnl = self.pnl.degraded(unavailable, reasons.clone());
        self.fees = self.fees.degraded(unavailable, reasons.clone());
        self.rewards = self.rewards.degraded(unavailable, reasons.clone());
        self.invested = self.invested.degraded(unavailable, reasons.clone());
        self.withdrawn = self.withdrawn.degraded(unavailable, reasons);
        self.average_held_seconds = None;
        self.median_held_seconds = None;
        self
    }

    /// `Σ PnL / Σ invested`, in `currency`.
    ///
    /// # Errors
    ///
    /// Returns [`RatioError::Overflow`] when the quotient overflows.
    pub fn pnl_percent(&self, currency: Currency) -> Result<Figure<Percent>, RatioError> {
        percent_of(&self.pnl, &self.invested, currency)
    }
}

/// `wins / (wins + losses)`.
fn win_rate(wins: usize, losses: usize) -> Figure<Percent> {
    let to_i128 = |count: usize| i128::try_from(count).unwrap_or(i128::MAX);
    let decided = to_i128(wins).saturating_add(to_i128(losses));
    match Percent::of(to_i128(wins), decided) {
        Ok(rate) => Figure::Complete(rate),
        Err(_) => Figure::unavailable(Reason::ZeroDenominator),
    }
}

/// The mean of sorted holding times, truncated to the second.
fn average(sorted: &[i64]) -> Option<i64> {
    let count = i128::try_from(sorted.len())
        .ok()
        .filter(|count| *count > 0)?;
    let total = sorted
        .iter()
        .try_fold(0_i128, |total, held| total.checked_add(i128::from(*held)))?;
    total
        .checked_div(count)
        .and_then(|mean| i64::try_from(mean).ok())
}

/// The median of sorted holding times; for an even count, the mean of the two middle ones
/// (truncated to the second).
fn median(sorted: &[i64]) -> Option<i64> {
    let upper_middle = sorted.len().checked_div(2)?;
    let upper = *sorted.get(upper_middle)?;
    if sorted.len() & 1 == 1 {
        return Some(upper);
    }
    let lower = *sorted.get(upper_middle.checked_sub(1)?)?;
    average(&[lower, upper])
}

#[cfg(test)]
mod tests {
    use binsight_core::money::SignedLamports;

    use super::*;

    fn position(pnl: i128, held_seconds: i64) -> ClosedValuation {
        let sol =
            |amount: i128| Figure::Complete(Valued::of_sol(SignedLamports(amount), None).unwrap());
        ClosedValuation {
            invested: sol(100),
            withdrawn: sol(100_i128.saturating_add(pnl)),
            claimed_fees: sol(1),
            rewards: sol(0),
            lp_pnl: sol(pnl),
            market_pnl: None,
            pnl: sol(pnl),
            native_pnl: Figure::Complete(super::super::valued::Money {
                raw: pnl,
                unit: super::super::valued::MoneyUnit::Sol,
            }),
            outcome: Outcome::of(crate::facts::QuoteUnits(pnl)),
            held_seconds,
            is_shell: false,
        }
    }

    #[test]
    fn leaves_flat_positions_out_of_the_win_rate() {
        let positions = [
            position(5, 10),
            position(-3, 20),
            position(0, 30),
            position(2, 40),
        ];
        let totals = ClosedTotals::of(&positions).unwrap();
        assert_eq!((totals.wins, totals.losses, totals.flat), (2, 1, 1));
        assert_eq!(totals.win_rate, Figure::Complete(Percent(66_666_667)));
        assert_eq!(totals.pnl.value().unwrap().sol, Some(SignedLamports(4)));
        assert_eq!(totals.average_held_seconds, Some(25));
        assert_eq!(totals.median_held_seconds, Some(25));
        assert_eq!(
            totals.pnl_percent(Currency::Sol).unwrap(),
            Figure::Complete(Percent(1_000_000))
        );
    }

    #[test]
    fn counts_unknown_outcomes_apart_and_leaves_them_out_of_the_win_rate() {
        let mut unknown = position(-40, 50);
        unknown.outcome = Outcome::Unknown;
        let positions = [position(5, 10), position(-3, 20), unknown];
        let totals = ClosedTotals::of(&positions).unwrap();
        assert_eq!(
            (totals.count, totals.wins, totals.losses, totals.unknown),
            (3, 1, 1, 1)
        );
        assert_eq!(totals.win_rate, Figure::Complete(Percent(50_000_000)));
        assert_eq!(totals.pnl.value().unwrap().sol, Some(SignedLamports(-38)));
    }

    #[test]
    fn gives_no_win_rate_and_no_holding_time_for_an_empty_set() {
        let totals = ClosedTotals::of(&[]).unwrap();
        assert_eq!(totals.count, 0);
        assert_eq!(totals.win_rate.exactness(), Exactness::Unavailable);
        assert_eq!(totals.average_held_seconds, None);
        assert_eq!(totals.median_held_seconds, None);
    }

    #[test]
    fn takes_the_middle_holding_time_of_an_odd_set() {
        let positions = [position(1, 50), position(1, 10), position(1, 30)];
        assert_eq!(
            ClosedTotals::of(&positions).unwrap().median_held_seconds,
            Some(30)
        );
    }
}
