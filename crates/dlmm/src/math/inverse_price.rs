//! A displayed price in token X per token Y, calculated from the original raw Y/X price.
//!
//! This is a decimal presentation conversion, not the program's bin exponentiation or an
//! amount valuation. Keeping the division remainder avoids inverting an already rounded price.

use binsight_core::price::{PRICE_DECIMALS, Price};
use binsight_core::units::Decimals;

use super::{BinMathError, Q64x64};

/// Whole token X per whole token Y, rounded down to the 18 decimals of [`Price`].
///
/// `raw` is the original Q64.64 Y/X price; `x` and `y` are the physical tokens' decimals.
/// A positive price below the display resolution becomes `Price(0)`. Amount valuation must
/// keep using the original raw price and exact division, never this descriptive price.
///
/// # Errors
/// Returns [`BinMathError::ZeroPrice`] for a zero raw price, or [`BinMathError::Overflow`]
/// when the displayed result does not fit in a [`Price`].
pub fn inverse_unit_price(raw: Q64x64, x: Decimals, y: Decimals) -> Result<Price, BinMathError> {
    let shift = i32::from(PRICE_DECIMALS.0)
        .checked_add(i32::from(y.0))
        .and_then(|shift| shift.checked_sub(i32::from(x.0)))
        .ok_or(BinMathError::Overflow)?;
    let mut whole = Q64x64::ONE
        .0
        .checked_div(raw.0)
        .ok_or(BinMathError::ZeroPrice)?;
    let mut remainder = Q64x64::ONE
        .0
        .checked_rem(raw.0)
        .ok_or(BinMathError::ZeroPrice)?;
    if shift < 0 {
        for _ in 0..shift.unsigned_abs() {
            whole = whole.checked_div(10).ok_or(BinMathError::Overflow)?;
        }
        return Ok(Price(whole));
    }
    for _ in 0..shift {
        let (digit, next_remainder) = decimal_digit(remainder, raw.0)?;
        whole = whole
            .checked_mul(10)
            .and_then(|tens| tens.checked_add(digit))
            .ok_or(BinMathError::Overflow)?;
        remainder = next_remainder;
    }
    Ok(Price(whole))
}

/// The next decimal digit and remainder, without forming the possibly overflowing `10 * r`.
fn decimal_digit(remainder: u128, divisor: u128) -> Result<(u128, u128), BinMathError> {
    let mut digit = 0_u128;
    let mut next = 0_u128;
    for _ in 0..10 {
        let gap = divisor.checked_sub(next).ok_or(BinMathError::Overflow)?;
        if remainder >= gap {
            next = remainder.checked_sub(gap).ok_or(BinMathError::Overflow)?;
            digit = digit.checked_add(1).ok_or(BinMathError::Overflow)?;
        } else {
            next = next.checked_add(remainder).ok_or(BinMathError::Overflow)?;
        }
    }
    Ok((digit, next))
}
