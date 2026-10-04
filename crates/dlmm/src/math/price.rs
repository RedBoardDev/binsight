//! The price of a bin: the program's `get_price_from_id`, and its conversion to a unit price.
//!
//! A bin's price is `(1 + bin_step / 10 000) ^ bin_id`, computed by the program by binary
//! exponentiation on Q64.64 numbers, inverting the base first so that every intermediate stays
//! below one and never overflows. This module repeats that algorithm step for step, rounding
//! included, so a price read here is the price the program uses.

use binsight_core::price::{PRICE_DECIMALS, Price};
use binsight_core::units::Decimals;

use super::q64::{FRACTION_BITS, Q64x64};

/// The denominator of a bin step: a bin step is in basis points.
const BASIS_POINT_MAX: u128 = 10_000;

/// The program refuses exponents of this magnitude or more: the price would leave Q64.64.
const MAX_EXPONENTIAL: u32 = 0x8_0000;

/// How many bits of the exponent the program reads (enough for every exponent below
/// [`MAX_EXPONENTIAL`]).
const EXPONENT_BITS: u32 = 19;

/// A bin price could not be computed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum BinMathError {
    /// The bin id is too far from zero for a Q64.64 price.
    #[error("the bin id is too far from zero for a bin price")]
    ExponentOutOfRange,
    /// The price rounds to zero (the program refuses it too).
    #[error("the bin price rounds to zero")]
    ZeroPrice,
    /// An intermediate result does not fit.
    #[error("the bin price overflows")]
    Overflow,
}

/// The Q64.64 price of `bin_id` in a pool of `bin_step` basis points: raw quote units per raw
/// base unit.
///
/// # Errors
///
/// Returns [`BinMathError`] when the bin is out of the range the program supports.
pub fn price_from_bin(bin_id: i32, bin_step: u16) -> Result<Q64x64, BinMathError> {
    let step = (u128::from(bin_step) << FRACTION_BITS) / BASIS_POINT_MAX;
    let base = Q64x64::ONE
        .0
        .checked_add(step)
        .ok_or(BinMathError::Overflow)?;
    pow(base, bin_id).map(Q64x64)
}

/// The program's `pow`: `base ^ exponent` on Q64.64 numbers.
fn pow(base: u128, exponent: i32) -> Result<u128, BinMathError> {
    if exponent == 0 {
        return Ok(Q64x64::ONE.0);
    }
    let magnitude = exponent.unsigned_abs();
    if magnitude >= MAX_EXPONENTIAL {
        return Err(BinMathError::ExponentOutOfRange);
    }
    let mut invert = exponent.is_negative();
    let mut squared = base;
    if squared >= Q64x64::ONE.0 {
        // Work on 1 / base, which stays below one, and remember to invert the result.
        squared = u128::MAX
            .checked_div(squared)
            .ok_or(BinMathError::Overflow)?;
        invert = !invert;
    }
    let mut result = Q64x64::ONE.0;
    for bit in 0..EXPONENT_BITS {
        if magnitude & (1 << bit) != 0 {
            result = shifted_product(result, squared)?;
        }
        squared = shifted_product(squared, squared)?;
    }
    if result == 0 {
        return Err(BinMathError::ZeroPrice);
    }
    if invert {
        result = u128::MAX
            .checked_div(result)
            .ok_or(BinMathError::Overflow)?;
    }
    Ok(result)
}

/// `left × right >> 64` as the program computes it (both factors are below 2^64 here).
fn shifted_product(left: u128, right: u128) -> Result<u128, BinMathError> {
    left.checked_mul(right)
        .map(|product| product >> FRACTION_BITS)
        .ok_or(BinMathError::Overflow)
}

/// The unit price of a raw Q64.64 price: whole quote tokens per whole base token, rounded down
/// to the 18 decimals of [`Price`].
///
/// # Errors
///
/// Returns [`BinMathError::Overflow`] when the price does not fit in a [`Price`].
pub fn unit_price(raw: Q64x64, base: Decimals, quote: Decimals) -> Result<Price, BinMathError> {
    // unit price = raw / 2^64 × 10^(base − quote), kept with 18 decimals.
    let shift = i32::from(PRICE_DECIMALS.0)
        .checked_add(i32::from(base.0))
        .and_then(|shift| shift.checked_sub(i32::from(quote.0)))
        .ok_or(BinMathError::Overflow)?;
    let mut whole = raw.0 >> FRACTION_BITS;
    let mut fraction = raw.0 & ((1 << FRACTION_BITS) - 1);
    for _ in 0..shift.max(0) {
        // Multiplying the fraction by ten carries at most four bits into the whole part.
        let carried = fraction.checked_mul(10).ok_or(BinMathError::Overflow)?;
        whole = whole
            .checked_mul(10)
            .and_then(|tens| tens.checked_add(carried >> FRACTION_BITS))
            .ok_or(BinMathError::Overflow)?;
        fraction = carried & ((1 << FRACTION_BITS) - 1);
    }
    let divisor = 10_u128
        .checked_pow(shift.min(0).unsigned_abs())
        .ok_or(BinMathError::Overflow)?;
    whole
        .checked_div(divisor)
        .map(Price)
        .ok_or(BinMathError::Overflow)
}

#[cfg(test)]
#[expect(
    clippy::arithmetic_side_effects,
    reason = "the tests compute oracles on small integers"
)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    #[test]
    fn prices_bin_zero_at_exactly_one() {
        assert_eq!(price_from_bin(0, 80), Ok(Q64x64::ONE));
    }

    #[test]
    fn prices_bin_one_at_one_plus_the_step() {
        // 1.001 in Q64.64, as the program writes the base for a 10 basis point step.
        let base = Q64x64::ONE.0 + (10_u128 << 64) / 10_000;
        let price = price_from_bin(1, 10).unwrap().0;
        assert!(price.abs_diff(base) <= 1, "{price} vs {base}");
    }

    #[test]
    fn bin_one_and_minus_one_are_inverse_within_one_unit_in_the_last_place() {
        let up = price_from_bin(1, 25).unwrap().0;
        let down = price_from_bin(-1, 25).unwrap().0;
        let product = (up >> 32) * (down >> 32);
        assert!(product.abs_diff(Q64x64::ONE.0) < 1 << 34, "{product}");
    }

    #[test]
    fn refuses_bins_beyond_the_program_range() {
        assert_eq!(
            price_from_bin(600_000, 1),
            Err(BinMathError::ExponentOutOfRange)
        );
    }

    #[test]
    fn converts_a_raw_price_to_a_unit_price_with_the_decimals() {
        // 1 raw JUP (6 decimals) = 4 000 lamports: 1 JUP = 0.004 SOL.
        let raw = Q64x64(4_000 << 64);
        let price = unit_price(raw, Decimals(6), Decimals(9)).unwrap();
        assert_eq!(price.to_significant_string(), "4");
        let price = unit_price(Q64x64(4 << 64), Decimals(6), Decimals(9)).unwrap();
        assert_eq!(price.to_significant_string(), "0.004");
    }

    proptest! {
        #[test]
        fn price_is_monotonic_in_bin_id(bin in -50_000_i32..50_000, step in 1_u16..400) {
            let here = price_from_bin(bin, step);
            let next = price_from_bin(bin + 1, step);
            if let (Ok(here), Ok(next)) = (here, next) {
                prop_assert!(here <= next);
            }
        }
    }
}
