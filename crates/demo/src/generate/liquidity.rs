//! Allocate synthetic native amounts into physical X/Y, then value them with the pool's single
//! quote rule. Raw prices remain physical Q64; displayed prices never allocate liquidity.

use binsight_core::error::AmountError;
use binsight_core::units::RawTokenAmount;
use binsight_dlmm::math::{BinMathError, Q64DivisionError, Q64x64, div_raw_q64, mul_shr_64};
use binsight_ledger::facts::{PhysicalSide, QuoteConvention};
use binsight_ledger::report::valued::quote::QuoteMathError;

use crate::error::DemoError;

/// Split a native target between both physical tokens, retaining the exact rounding remainder
/// in the selected token. Its value at this same source price equals the target.
pub(super) fn split_native(
    amount: RawTokenAmount,
    quote: QuoteConvention,
    price: Q64x64,
) -> Result<(RawTokenAmount, RawTokenAmount), DemoError> {
    let half = RawTokenAmount(amount.0 / 2);
    let other_side = match quote.side() {
        PhysicalSide::X => PhysicalSide::Y,
        PhysicalSide::Y => PhysicalSide::X,
    };
    let (x, y) = allocate_on_side(half, quote, other_side, price)?;
    let converted = native_value((x, y), quote, price)?;
    let remainder = RawTokenAmount(
        amount
            .0
            .checked_sub(converted.0)
            .ok_or(AmountError::Overflow)?,
    );
    Ok(match quote.side() {
        PhysicalSide::X => (remainder, y),
        PhysicalSide::Y => (x, remainder),
    })
}

/// Allocate a target into one physical side; conversion can round it down. Consumers recompute
/// the resulting native value from these raw quantities instead of reporting the target.
pub(super) fn allocate_on_side(
    amount: RawTokenAmount,
    quote: QuoteConvention,
    side: PhysicalSide,
    price: Q64x64,
) -> Result<(RawTokenAmount, RawTokenAmount), DemoError> {
    if price.0 == 0 {
        return Err(BinMathError::ZeroPrice.into());
    }
    let raw = if side == quote.side() {
        amount
    } else {
        match side {
            PhysicalSide::X => div_raw_q64(amount, price).map_err(|error| match error {
                Q64DivisionError::ZeroPrice => DemoError::BinMath(BinMathError::ZeroPrice),
                Q64DivisionError::Overflow => DemoError::Amount(AmountError::Overflow),
            })?,
            PhysicalSide::Y => {
                RawTokenAmount(mul_shr_64(amount.0, price).ok_or(AmountError::Overflow)?)
            }
        }
    };
    Ok(match side {
        PhysicalSide::X => (raw, RawTokenAmount(0)),
        PhysicalSide::Y => (RawTokenAmount(0), raw),
    })
}

/// Reuse the domain's sole raw valuation rule at the actual allocation price.
pub(super) fn native_value(
    (x, y): (RawTokenAmount, RawTokenAmount),
    quote: QuoteConvention,
    price: Q64x64,
) -> Result<RawTokenAmount, DemoError> {
    quote
        .value_raw(x, y, Some(price))
        .map(|value| value.amount)
        .map_err(|error| match error {
            QuoteMathError::ZeroPrice => DemoError::BinMath(BinMathError::ZeroPrice),
            QuoteMathError::Overflow => DemoError::Amount(AmountError::Overflow),
        })
}
