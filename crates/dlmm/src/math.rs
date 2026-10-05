//! The fixed-point maths of DLMM bins, exactly as the on-chain program computes it.
//!
//! Bin prices are Q64.64 numbers (a `u128` whose low 64 bits are the fraction): the price of one
//! raw unit of the base token (X) in raw units of the quote token (Y). They are computed with the
//! program's own algorithm, so binsight values an amount to the same unit the program does. No
//! floating point is involved anywhere.

mod position_amounts;
mod price;
mod proportional_amount;
mod q64;

pub use position_amounts::{PositionAmounts, PositionValueError, position_amounts};
pub use price::{BinMathError, price_from_bin, unit_price};
pub use q64::{Q64x64, div_q64, mul_shr_64};
