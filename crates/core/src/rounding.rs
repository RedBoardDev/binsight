//! Integer division rounded half to even (banker's rounding), the one rounding rule of binsight.
//!
//! Whenever an exact amount must be divided (a conversion, a percentage, a price), the result is
//! rounded to the nearest integer and a tie goes to the even neighbour, so rounding errors do not
//! drift in one direction over many figures. This module only divides; it does not know units.

use std::cmp::Ordering;

/// `numerator / denominator`, rounded half to even.
///
/// Returns `None` when `denominator` is zero or the result does not fit (`i128::MIN / -1`).
pub(crate) fn divide_half_even(numerator: i128, denominator: i128) -> Option<i128> {
    let quotient = numerator.checked_div(denominator)?;
    let remainder = numerator.checked_rem(denominator)?;
    if remainder == 0 {
        return Some(quotient);
    }
    let is_odd = quotient & 1 == 1;
    if !rounds_away_from_zero(remainder.unsigned_abs(), denominator.unsigned_abs(), is_odd)? {
        return Some(quotient);
    }
    // The exact result lies strictly between `quotient` and its neighbour away from zero.
    if (numerator < 0) == (denominator < 0) {
        quotient.checked_add(1)
    } else {
        quotient.checked_sub(1)
    }
}

/// `numerator / denominator` for unsigned values, rounded half to even.
///
/// Returns `None` when `denominator` is zero or the rounded result does not fit.
pub(crate) fn divide_half_even_unsigned(numerator: u128, denominator: u128) -> Option<u128> {
    let quotient = numerator.checked_div(denominator)?;
    let remainder = numerator.checked_rem(denominator)?;
    if remainder == 0 {
        return Some(quotient);
    }
    if rounds_away_from_zero(remainder, denominator, quotient & 1 == 1)? {
        quotient.checked_add(1)
    } else {
        Some(quotient)
    }
}

/// Whether a truncated `quotient` with this non-zero `remainder` must move one step away from
/// zero: when the remainder is more than half the divisor, or exactly half and the quotient odd.
fn rounds_away_from_zero(remainder: u128, divisor: u128, is_quotient_odd: bool) -> Option<bool> {
    // `remainder < divisor <= 2^127`, so doubling it cannot overflow a `u128`.
    let twice_remainder = remainder.checked_mul(2)?;
    Some(match twice_remainder.cmp(&divisor) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => is_quotient_odd,
    })
}

#[cfg(test)]
#[expect(
    clippy::arithmetic_side_effects,
    reason = "the oracles compute in plain integers on inputs bounded far below overflow"
)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    #[test]
    fn rounds_ties_to_the_even_neighbour() {
        assert_eq!(divide_half_even(5, 2), Some(2));
        assert_eq!(divide_half_even(7, 2), Some(4));
        assert_eq!(divide_half_even(-5, 2), Some(-2));
        assert_eq!(divide_half_even(-7, 2), Some(-4));
        assert_eq!(divide_half_even(5, -2), Some(-2));
        assert_eq!(divide_half_even_unsigned(5, 2), Some(2));
        assert_eq!(divide_half_even_unsigned(7, 2), Some(4));
    }

    #[test]
    fn rounds_to_the_nearest_integer_otherwise() {
        assert_eq!(divide_half_even(10, 3), Some(3));
        assert_eq!(divide_half_even(11, 3), Some(4));
        assert_eq!(divide_half_even(-11, 3), Some(-4));
        assert_eq!(divide_half_even(-10, 3), Some(-3));
        assert_eq!(divide_half_even_unsigned(11, 3), Some(4));
    }

    #[test]
    fn refuses_a_zero_denominator_and_an_overflow() {
        assert_eq!(divide_half_even(1, 0), None);
        assert_eq!(divide_half_even(i128::MIN, -1), None);
        assert_eq!(divide_half_even_unsigned(1, 0), None);
        assert_eq!(divide_half_even_unsigned(u128::MAX, 1), Some(u128::MAX));
    }

    proptest! {
        #[test]
        fn stays_within_half_a_unit_of_the_exact_result(
            numerator in -1_000_000_000_000_i128..1_000_000_000_000,
            denominator in 1_i128..1_000_000,
        ) {
            let rounded = divide_half_even(numerator, denominator).unwrap();
            // |numerator - rounded * denominator| <= denominator / 2, in integers.
            let error = (numerator - rounded * denominator).abs() * 2;
            prop_assert!(error <= denominator);
        }

        #[test]
        fn is_symmetric_in_sign(numerator: i64, denominator in 1_i64..i64::MAX) {
            let positive = divide_half_even(i128::from(numerator), i128::from(denominator));
            let negative = divide_half_even(-i128::from(numerator), i128::from(denominator));
            prop_assert_eq!(positive.map(|value| -value), negative);
        }
    }
}
