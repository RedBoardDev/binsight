//! Exact percentages and ratios with six decimal places.
//!
//! A percentage such as a win rate or a gain is the quotient of two exact integers, so it is
//! computed once, in integers, rounded half to even at the sixth decimal, and written as a
//! canonical decimal string. A zero denominator is an explicit error, never a silent zero. This
//! module does not decide which numbers to divide.

use std::fmt;

use crate::decimal::format_signed_units;
use crate::rounding::divide_half_even;
use crate::units::Decimals;

/// The number of decimal places kept by [`Percent`] and [`Ratio`].
pub const RATIO_DECIMALS: Decimals = Decimals(6);

/// One unit, at the scale of [`RATIO_DECIMALS`].
const RATIO_SCALE: i128 = 1_000_000;

/// One hundred percent, at the scale of [`RATIO_DECIMALS`].
const HUNDRED_PERCENT: i128 = 100_000_000;

/// A quotient could not be computed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RatioError {
    /// The denominator is zero: the quotient has no value.
    #[error("the denominator is zero")]
    ZeroDenominator,
    /// The numerator is too large to be scaled.
    #[error("the quotient is too large")]
    Overflow,
}

/// A percentage in millionths of a percent: `Percent(2_560_000)` is 2.56 %.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Percent(pub i128);

/// A plain quotient (such as a profit factor) in millionths: `Ratio(1_830_000)` is 1.83.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Ratio(pub i128);

impl Percent {
    /// Zero percent.
    pub const ZERO: Self = Self(0);

    /// `numerator / denominator` as a percentage, rounded half to even.
    ///
    /// # Errors
    ///
    /// Returns [`RatioError::ZeroDenominator`] when `denominator` is zero and
    /// [`RatioError::Overflow`] when the numerator is too large to scale.
    pub fn of(numerator: i128, denominator: i128) -> Result<Self, RatioError> {
        scaled_quotient(numerator, denominator, HUNDRED_PERCENT).map(Self)
    }

    /// The percentage as a canonical decimal string, in percent: `"2.56"` for 2.56 %.
    pub fn to_decimal_string(self) -> String {
        format_signed_units(self.0, RATIO_DECIMALS)
    }
}

impl Ratio {
    /// `numerator / denominator`, rounded half to even.
    ///
    /// # Errors
    ///
    /// Returns [`RatioError::ZeroDenominator`] when `denominator` is zero and
    /// [`RatioError::Overflow`] when the numerator is too large to scale.
    pub fn of(numerator: i128, denominator: i128) -> Result<Self, RatioError> {
        scaled_quotient(numerator, denominator, RATIO_SCALE).map(Self)
    }

    /// The ratio as a canonical decimal string: `"1.83"`.
    pub fn to_decimal_string(self) -> String {
        format_signed_units(self.0, RATIO_DECIMALS)
    }
}

impl fmt::Display for Percent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} %", self.to_decimal_string())
    }
}

impl fmt::Display for Ratio {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.to_decimal_string())
    }
}

/// `numerator * scale / denominator`, rounded half to even.
fn scaled_quotient(numerator: i128, denominator: i128, scale: i128) -> Result<i128, RatioError> {
    if denominator == 0 {
        return Err(RatioError::ZeroDenominator);
    }
    numerator
        .checked_mul(scale)
        .and_then(|scaled| divide_half_even(scaled, denominator))
        .ok_or(RatioError::Overflow)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    #[test]
    fn computes_the_named_percentages() {
        assert_eq!(Percent::of(1, 1).unwrap().to_decimal_string(), "100");
        assert_eq!(Percent::of(0, 7).unwrap().to_decimal_string(), "0");
        assert_eq!(Percent::of(1, 3).unwrap().to_decimal_string(), "33.333333");
        assert_eq!(Percent::of(2, 3).unwrap().to_decimal_string(), "66.666667");
        assert_eq!(
            Percent::of(-256, 10_000).unwrap().to_decimal_string(),
            "-2.56"
        );
    }

    #[test]
    fn computes_a_plain_ratio() {
        assert_eq!(Ratio::of(183, 100).unwrap().to_decimal_string(), "1.83");
        assert_eq!(Ratio::of(183, 100).unwrap().to_string(), "1.83");
    }

    #[test]
    fn refuses_a_zero_denominator_and_an_overflow() {
        assert_eq!(Percent::of(1, 0), Err(RatioError::ZeroDenominator));
        assert_eq!(Ratio::of(i128::MAX, 1), Err(RatioError::Overflow));
    }

    proptest! {
        #[test]
        fn is_monotonic_in_the_numerator(a: i64, b: i64, denominator in 1_i64..i64::MAX) {
            let (low, high) = (a.min(b), a.max(b));
            let low = Percent::of(i128::from(low), i128::from(denominator)).unwrap();
            let high = Percent::of(i128::from(high), i128::from(denominator)).unwrap();
            prop_assert!(low <= high);
        }

        #[test]
        fn a_whole_is_always_one_hundred_percent(value in 1_i64..i64::MAX) {
            prop_assert_eq!(
                Percent::of(i128::from(value), i128::from(value)),
                Ok(Percent(HUNDRED_PERCENT))
            );
        }
    }
}
