//! Convert physical X/Y amounts and prices with the pool's selected quote convention.
//!
//! Raw amounts keep exact Q64 arithmetic. Descriptive prices never value an amount, and a
//! missing bin price leaves the selected raw quote amount known without guessing the other side.

use binsight_core::price::Price;
use binsight_core::units::{Decimals, RawTokenAmount};
use binsight_dlmm::math::{
    BinMathError, Q64DivisionError, Q64x64, div_raw_q64, inverse_unit_price, mul_shr_64, unit_price,
};

use crate::facts::{FlowValuation, PhysicalSide, QuoteConvention};

/// A known amount in the selected quote token, with the source's pricing coverage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuotedAmount {
    /// Raw units of the selected quote token.
    pub amount: RawTokenAmount,
    /// Whether both physical sides are known or only the selected quote side is valued.
    pub valuation: FlowValuation,
}

/// Physical amounts cannot be valued in the selected quote token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum QuoteMathError {
    /// A supplied raw price is zero, even if the amounts are zero.
    #[error("the quote conversion price is zero")]
    ZeroPrice,
    /// A converted amount or the sum exceeds the raw amount's integer range.
    #[error("the quote conversion amount overflows")]
    Overflow,
}

impl QuoteConvention {
    /// A descriptive price in the selected token, from the original raw physical Y/X price.
    ///
    /// `x` and `y` are the physical tokens' verified decimals, independent of display order.
    ///
    /// # Errors
    /// Returns [`BinMathError`] when the descriptive price does not fit or the raw price is zero.
    pub fn unit_price(self, raw: Q64x64, x: Decimals, y: Decimals) -> Result<Price, BinMathError> {
        if raw.0 == 0 {
            return Err(BinMathError::ZeroPrice);
        }
        match self.side() {
            PhysicalSide::X => inverse_unit_price(raw, x, y),
            PhysicalSide::Y => unit_price(raw, x, y),
        }
    }

    /// Values physical X and Y raw amounts at their original raw Y/X price.
    ///
    /// With no price, the selected quote amount stays known. A nonzero other-side amount
    /// makes coverage [`FlowValuation::QuoteOnly`]; zero other-side amount is fully valued.
    /// This is an unsigned raw valuation. Signed differences and history quality belong to
    /// their consumers, which must preserve this coverage when building their figures.
    ///
    /// # Errors
    /// Returns [`QuoteMathError::ZeroPrice`] for a supplied zero price, or
    /// [`QuoteMathError::Overflow`] when a conversion or the raw sum cannot fit.
    pub fn value_raw(
        self,
        x: RawTokenAmount,
        y: RawTokenAmount,
        raw: Option<Q64x64>,
    ) -> Result<QuotedAmount, QuoteMathError> {
        let (quote, other) = match self.side() {
            PhysicalSide::X => (x, y),
            PhysicalSide::Y => (y, x),
        };
        let Some(raw) = raw else {
            return Ok(QuotedAmount {
                amount: quote,
                valuation: if other.0 == 0 {
                    FlowValuation::Complete
                } else {
                    FlowValuation::QuoteOnly
                },
            });
        };
        if raw.0 == 0 {
            return Err(QuoteMathError::ZeroPrice);
        }
        let converted = match self.side() {
            PhysicalSide::X => div_raw_q64(other, raw).map_err(|error| match error {
                Q64DivisionError::ZeroPrice => QuoteMathError::ZeroPrice,
                Q64DivisionError::Overflow => QuoteMathError::Overflow,
            })?,
            PhysicalSide::Y => {
                RawTokenAmount(mul_shr_64(other.0, raw).ok_or(QuoteMathError::Overflow)?)
            }
        };
        Ok(QuotedAmount {
            amount: quote
                .try_add(converted)
                .map_err(|_| QuoteMathError::Overflow)?,
            valuation: FlowValuation::Complete,
        })
    }
}
