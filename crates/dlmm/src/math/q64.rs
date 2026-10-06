//! Q64.64 fixed-point numbers and the two operations that value amounts with them.

use binsight_core::units::RawTokenAmount;

/// A Q64.64 fixed-point number: `value / 2^64`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Q64x64(pub u128);

impl Q64x64 {
    /// One, `2^64`.
    pub const ONE: Self = Self(1 << FRACTION_BITS);
}

/// The number of fraction bits.
pub(super) const FRACTION_BITS: u32 = 64;

/// The low 64 bits of a `u128`.
const LOW_BITS: u128 = (1 << FRACTION_BITS) - 1;

/// `floor(amount × price / 2^64)`: the value in quote units of `amount` base units, computed
/// without a 256-bit intermediate. `None` only when the result does not fit in a `u128`.
pub fn mul_shr_64(amount: u128, price: Q64x64) -> Option<u128> {
    let high = price.0 >> FRACTION_BITS;
    let low = price.0 & LOW_BITS;
    // amount × price / 2^64 = amount × high + amount × low / 2^64; the second term is split again
    // so that no product exceeds 128 bits.
    let amount_high = amount >> FRACTION_BITS;
    let amount_low = amount & LOW_BITS;
    let whole = amount.checked_mul(high)?;
    let cross = amount_high.checked_mul(low)?;
    let fraction = amount_low.checked_mul(low)? >> FRACTION_BITS;
    whole.checked_add(cross)?.checked_add(fraction)
}

/// An amount cannot be divided by a Q64.64 price.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Q64DivisionError {
    /// The denominator is zero.
    #[error("the Q64 price is zero")]
    ZeroPrice,
    /// The quotient exceeds the raw amount's integer range.
    #[error("the amount divided by the Q64 price overflows")]
    Overflow,
}

/// `floor(value × 2^64 / price)`, including values above `u64::MAX`.
///
/// Divides the original amount first, then appends its 64 fractional zero bits by long division.
/// The remainder stays below the price, so neither it nor an intermediate product needs 192 bits.
///
/// # Errors
/// Returns [`Q64DivisionError::ZeroPrice`] for a zero price and
/// [`Q64DivisionError::Overflow`] when the final raw amount does not fit in a `u128`.
pub fn div_raw_q64(
    value: RawTokenAmount,
    price: Q64x64,
) -> Result<RawTokenAmount, Q64DivisionError> {
    let mut quotient = value
        .0
        .checked_div(price.0)
        .ok_or(Q64DivisionError::ZeroPrice)?;
    let mut remainder = value
        .0
        .checked_rem(price.0)
        .ok_or(Q64DivisionError::ZeroPrice)?;
    for _ in 0..FRACTION_BITS {
        let gap = price
            .0
            .checked_sub(remainder)
            .ok_or(Q64DivisionError::Overflow)?;
        let carry = u128::from(remainder >= gap);
        remainder = if remainder >= gap {
            remainder.checked_sub(gap)
        } else {
            remainder.checked_add(remainder)
        }
        .ok_or(Q64DivisionError::Overflow)?;
        quotient = quotient
            .checked_mul(2)
            .and_then(|doubled| doubled.checked_add(carry))
            .ok_or(Q64DivisionError::Overflow)?;
    }
    Ok(RawTokenAmount(quotient))
}

#[cfg(test)]
#[expect(
    clippy::arithmetic_side_effects,
    reason = "the oracle multiplies within the bounds the property test draws"
)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    /// `a × b / 2^64` with a 256-bit product written out by hand, as the oracle.
    fn wide_mul_shr_64(a: u128, b: u128) -> Option<u128> {
        let (a_high, a_low) = (a >> 64, a & LOW_BITS);
        let (b_high, b_low) = (b >> 64, b & LOW_BITS);
        // a × b = hh·2^128 + (hl + lh)·2^64 + ll; shifted right by 64.
        let ll = a_low * b_low;
        let middle = (a_high * b_low) + (a_low * b_high) + (ll >> 64);
        let hh = a_high.checked_mul(b_high)?;
        hh.checked_shl(64)
            .filter(|shifted| shifted >> 64 == hh)?
            .checked_add(middle)
    }

    #[test]
    fn values_an_amount_at_a_price_of_one_and_a_half() {
        let one_and_a_half = Q64x64(Q64x64::ONE.0 + (Q64x64::ONE.0 >> 1));
        assert_eq!(mul_shr_64(1_000, one_and_a_half), Some(1_500));
        assert_eq!(
            div_raw_q64(RawTokenAmount(1_500), one_and_a_half),
            Ok(RawTokenAmount(1_000))
        );
        assert_eq!(
            div_raw_q64(RawTokenAmount(1), Q64x64(0)),
            Err(Q64DivisionError::ZeroPrice)
        );
    }

    proptest! {
        #[test]
        fn mul_shr_64_equals_the_wide_multiplication(amount in 0_u128..(1 << 80), price: u64, whole in 0_u128..(1 << 40)) {
            let price = (whole << 64) | u128::from(price);
            prop_assert_eq!(mul_shr_64(amount, Q64x64(price)), wide_mul_shr_64(amount, price));
        }
    }
}
