//! A running total of valued figures over time, read at any instant in logarithmic time.
//!
//! The real PnL and the capital of a wallet at a past instant are sums of everything up to that
//! instant. Building the running sum once per snapshot makes each read a binary search instead of
//! a scan. A leaf that is partial or unavailable keeps its mark from its instant on, so the total
//! read at a later instant carries its exactness and reasons.

use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use jiff::Timestamp;

use crate::report::figure::{Figure, Reasons};
use crate::report::valued::Valued;

/// The running total of a series of dated valued figures.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunningSum {
    /// The total right after each instant, in time order.
    totals: Vec<(Timestamp, Valued)>,
    /// The leaves that were not complete: their instant, exactness and reasons, in time order.
    marks: Vec<(Timestamp, Exactness, Reasons)>,
}

impl RunningSum {
    /// The running sum of `leaves`, in any order.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a total overflows.
    pub fn new(
        leaves: impl IntoIterator<Item = (Timestamp, Figure<Valued>)>,
    ) -> Result<Self, AmountError> {
        let mut leaves: Vec<(Timestamp, Figure<Valued>)> = leaves.into_iter().collect();
        leaves.sort_by_key(|(at, _)| *at);
        let mut running = Self::default();
        let mut total = Valued::ZERO;
        for (at, leaf) in leaves {
            if leaf.exactness() != Exactness::Complete {
                running.marks.push((at, leaf.exactness(), leaf.reasons()));
            }
            if let Some(value) = leaf.value() {
                total = total.try_add(*value)?;
            }
            running.totals.push((at, total));
        }
        Ok(running)
    }

    /// The total of the leaves at or before `instant`.
    pub fn at(&self, instant: Timestamp) -> Figure<Valued> {
        let (exactness, reasons) = self.marks_where(|at| at <= instant);
        Figure::from_parts(self.total_of_prefix(|at| at <= instant), exactness, reasons)
    }

    /// The total of the leaves strictly before `instant`, for windows that exclude their end.
    pub fn before(&self, instant: Timestamp) -> Figure<Valued> {
        let (exactness, reasons) = self.marks_where(|at| at < instant);
        Figure::from_parts(self.total_of_prefix(|at| at < instant), exactness, reasons)
    }

    /// The total of the leaves at or after `start` and strictly before `end`.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when the difference overflows.
    pub fn during(&self, start: Timestamp, end: Timestamp) -> Result<Figure<Valued>, AmountError> {
        let until_end = self.total_of_prefix(|at| at < end);
        let until_start = self.total_of_prefix(|at| at < start);
        let (exactness, reasons) = self.marks_where(|at| start <= at && at < end);
        Ok(Figure::from_parts(
            until_end.try_sub(until_start)?,
            exactness,
            reasons,
        ))
    }

    /// The running total after the leading leaves whose instant satisfies `is_in_prefix` (a
    /// predicate true for a prefix of the time order).
    fn total_of_prefix(&self, is_in_prefix: impl Fn(Timestamp) -> bool) -> Valued {
        let count = self.totals.partition_point(|(at, _)| is_in_prefix(*at));
        count
            .checked_sub(1)
            .and_then(|last| self.totals.get(last))
            .map_or(Valued::ZERO, |(_, total)| *total)
    }

    /// The combined exactness and reasons of the incomplete leaves whose instant satisfies
    /// `is_selected`.
    fn marks_where(&self, is_selected: impl Fn(Timestamp) -> bool) -> (Exactness, Reasons) {
        let mut exactness = Exactness::Complete;
        let mut reasons = Reasons::new();
        for (_, mark, mark_reasons) in self.marks.iter().filter(|(at, ..)| is_selected(*at)) {
            exactness = exactness.combine(*mark);
            reasons.extend(mark_reasons.iter().copied());
        }
        (exactness, reasons)
    }

    /// The instant of the first leaf, if any.
    pub fn first_instant(&self) -> Option<Timestamp> {
        self.totals.first().map(|(at, _)| *at)
    }
}

#[cfg(test)]
mod tests {
    use binsight_core::money::SignedLamports;

    use super::*;
    use crate::report::figure::Reason;

    fn at(second: i64) -> Timestamp {
        Timestamp::from_second(second).unwrap()
    }

    fn lamports(amount: i128) -> Figure<Valued> {
        Figure::Complete(Valued::of_sol(SignedLamports(amount), None).unwrap())
    }

    #[test]
    fn sums_everything_up_to_an_instant() {
        let sum = RunningSum::new([(at(20), lamports(5)), (at(10), lamports(2))]).unwrap();
        assert_eq!(sum.at(at(9)).value().unwrap().sol, Some(SignedLamports(0)));
        assert_eq!(sum.at(at(10)).value().unwrap().sol, Some(SignedLamports(2)));
        assert_eq!(sum.at(at(25)).value().unwrap().sol, Some(SignedLamports(7)));
        assert_eq!(
            sum.before(at(20)).value().unwrap().sol,
            Some(SignedLamports(2))
        );
        let during = sum.during(at(11), at(21)).unwrap();
        assert_eq!(during.value().unwrap().sol, Some(SignedLamports(5)));
        assert_eq!(sum.first_instant(), Some(at(10)));
    }

    #[test]
    fn keeps_a_partial_leaf_partial_from_its_instant_on() {
        let partial = Figure::Partial {
            value: Valued::of_sol(SignedLamports(3), None).unwrap(),
            reasons: Reasons::from([Reason::NoLosses]),
        };
        let sum = RunningSum::new([(at(10), lamports(1)), (at(20), partial)]).unwrap();
        assert_eq!(sum.at(at(15)).exactness(), Exactness::Complete);
        assert_eq!(sum.at(at(20)).exactness(), Exactness::Partial);
        assert_eq!(sum.at(at(20)).value().unwrap().sol, Some(SignedLamports(4)));
        assert_eq!(
            sum.during(at(21), at(30)).unwrap().exactness(),
            Exactness::Complete
        );
    }
}
