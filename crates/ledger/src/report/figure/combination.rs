//! How the exactness of figures combines in sums, differences and quotients.

use binsight_core::exactness::Exactness;
use binsight_core::ratio::RatioError;

use super::{Figure, Reason};

/// How two figures are combined, which decides the exactness of the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Combination {
    /// `a + b`: the least trustworthy status wins.
    Sum,
    /// `a − b`: as a sum, except that subtracting a partial figure gives an estimated one.
    Difference,
    /// `a / b`: a partial denominator cannot bound the quotient, so it is estimated.
    Quotient,
}

impl<T> Figure<T> {
    /// Combines two figures with `operation`, following `combination` for the exactness.
    ///
    /// # Errors
    ///
    /// Returns the error of `operation`.
    pub fn combine<U, V, E>(
        self,
        other: Figure<U>,
        combination: Combination,
        operation: impl FnOnce(T, U) -> Result<V, E>,
    ) -> Result<Figure<V>, E> {
        let (left, left_exactness, mut reasons) = self.into_parts();
        let (right, right_exactness, right_reasons) = other.into_parts();
        reasons.extend(right_reasons);
        let exactness = combined_exactness(left_exactness, right_exactness, combination);
        Ok(match (left, right) {
            (Some(left), Some(right)) => {
                Figure::from_parts(operation(left, right)?, exactness, reasons)
            }
            _ => Figure::Unavailable { reasons },
        })
    }

    /// Divides this figure by `other` with `operation`; a zero denominator makes the result
    /// unavailable with [`Reason::ZeroDenominator`].
    ///
    /// # Errors
    ///
    /// Returns [`RatioError::Overflow`] when the quotient overflows.
    pub fn divide<U, V>(
        self,
        other: Figure<U>,
        operation: impl FnOnce(T, U) -> Result<V, RatioError>,
    ) -> Result<Figure<V>, RatioError> {
        let quotient = self.combine(
            other,
            Combination::Quotient,
            |left, right| match operation(left, right) {
                Ok(value) => Ok(Some(value)),
                Err(RatioError::ZeroDenominator) => Ok(None),
                Err(RatioError::Overflow) => Err(RatioError::Overflow),
            },
        )?;
        let (value, exactness, mut reasons) = quotient.into_parts();
        if let Some(Some(value)) = value {
            return Ok(Figure::from_parts(value, exactness, reasons));
        }
        if exactness != Exactness::Unavailable {
            reasons.insert(Reason::ZeroDenominator);
        }
        Ok(Figure::Unavailable { reasons })
    }
}

/// The exactness of `left (combination) right`.
fn combined_exactness(left: Exactness, right: Exactness, combination: Combination) -> Exactness {
    let combined = left.combine(right);
    if combination != Combination::Sum && right == Exactness::Partial {
        return combined.combine(Exactness::Estimated);
    }
    combined
}

/// Sums figures with `add`, from `zero`.
///
/// # Errors
///
/// Returns the error of `add`.
pub fn sum_figures<T: Clone, E>(
    figures: impl IntoIterator<Item = Figure<T>>,
    zero: T,
    add: impl Fn(T, T) -> Result<T, E>,
) -> Result<Figure<T>, E> {
    figures
        .into_iter()
        .try_fold(Figure::Complete(zero), |total, figure| {
            total.combine(figure, Combination::Sum, &add)
        })
}

#[cfg(test)]
#[expect(
    clippy::arithmetic_side_effects,
    reason = "the oracles add small integers"
)]
mod tests {
    use binsight_core::exactness::Exactness::{Complete, Estimated, Partial, Unavailable};
    use binsight_core::ratio::Percent;

    use super::super::Reasons;
    use super::*;

    fn figure(value: i128, exactness: Exactness) -> Figure<i128> {
        let reasons = match exactness {
            Complete => Reasons::new(),
            _ => Reasons::from([Reason::NoUsdRate]),
        };
        Figure::from_parts(value, exactness, reasons)
    }

    fn subtract(left: Exactness, right: Exactness) -> Exactness {
        figure(5, left)
            .combine(figure(3, right), Combination::Difference, |a, b| {
                Ok::<_, ()>(a - b)
            })
            .unwrap()
            .exactness()
    }

    #[test]
    fn subtracts_following_the_table() {
        assert_eq!(subtract(Complete, Complete), Complete);
        assert_eq!(subtract(Partial, Complete), Partial);
        assert_eq!(subtract(Complete, Partial), Estimated);
        assert_eq!(subtract(Partial, Partial), Estimated);
        assert_eq!(subtract(Estimated, Complete), Estimated);
        assert_eq!(subtract(Complete, Estimated), Estimated);
        assert_eq!(subtract(Unavailable, Complete), Unavailable);
        assert_eq!(subtract(Complete, Unavailable), Unavailable);
    }

    #[test]
    fn sums_to_the_least_trustworthy_status_and_merges_reasons() {
        let total = sum_figures(
            [
                figure(1, Complete),
                Figure::from_parts(2, Partial, Reasons::from([Reason::NoUsdRate])),
                Figure::from_parts(3, Partial, Reasons::from([Reason::NoUsdRate])),
            ],
            0,
            |a, b| Ok::<_, ()>(a + b),
        )
        .unwrap();
        assert_eq!(
            total,
            Figure::Partial {
                value: 6,
                reasons: Reasons::from([Reason::NoUsdRate])
            }
        );
    }

    #[test]
    fn quotients_with_a_partial_denominator_are_estimates() {
        for left in [Complete, Partial, Estimated, Unavailable] {
            for right in [Complete, Partial, Estimated, Unavailable] {
                let quotient = figure(5, left)
                    .divide(figure(10, right), Percent::of)
                    .unwrap();
                let expected = if left == Unavailable || right == Unavailable {
                    Unavailable
                } else if right == Partial || left == Estimated || right == Estimated {
                    Estimated
                } else {
                    left
                };
                assert_eq!(quotient.exactness(), expected, "{left:?} / {right:?}");
            }
        }
    }

    #[test]
    fn makes_a_quotient_by_zero_unavailable() {
        let quotient = figure(5, Complete)
            .divide(figure(0, Complete), Percent::of)
            .unwrap();
        assert_eq!(quotient, Figure::unavailable(Reason::ZeroDenominator));
        let half = figure(1, Complete)
            .divide(figure(2, Complete), Percent::of)
            .unwrap();
        assert_eq!(half, Figure::Complete(Percent(50_000_000)));
    }
}
