//! Bin prices for the generator: the exact price of a bin, and the bin of a given price.

use binsight_dlmm::math::{BinMathError, Q64x64, price_from_bin};

/// The widest bin id searched, times the bin step: prices stay well inside Q64.64 (whose range
/// ends around 443 000 basis points of steps either way).
const SEARCH_LIMIT_STEPS: i32 = 400_000;

/// The exact Q64.64 price of `bin_id` in a pool of `bin_step` basis points.
pub(crate) fn bin_price(bin_id: i32, bin_step: u16) -> Result<Q64x64, BinMathError> {
    price_from_bin(bin_id, bin_step)
}

/// The highest bin whose price is at most `target` (raw quote units per raw base unit, Q64.64).
pub(crate) fn bin_at_or_below(target: Q64x64, bin_step: u16) -> Result<i32, BinMathError> {
    let limit = SEARCH_LIMIT_STEPS
        .checked_div(i32::from(bin_step))
        .unwrap_or(SEARCH_LIMIT_STEPS);
    let (mut low, mut high) = (limit.saturating_neg(), limit);
    while low < high {
        // The upper middle, so that `low = middle` always moves forward.
        let middle = low.saturating_add(high.saturating_sub(low).saturating_add(1) / 2);
        if bin_price(middle, bin_step)? <= target {
            low = middle;
        } else {
            high = middle.saturating_sub(1);
        }
    }
    Ok(low)
}

/// The Q64.64 raw price of a token worth `numerator / denominator` whole quote tokens, given the
/// decimals of both tokens. `None` when it does not fit.
pub(crate) fn raw_price(
    numerator: u128,
    denominator: u128,
    base_decimals: u8,
    quote_decimals: u8,
) -> Option<Q64x64> {
    let scaled = numerator.checked_mul(10_u128.checked_pow(u32::from(quote_decimals))?)?;
    let divisor = denominator.checked_mul(10_u128.checked_pow(u32::from(base_decimals))?)?;
    scaled.checked_shl(64)?.checked_div(divisor).map(Q64x64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_bin_of_a_price() {
        // 1 JUP (6 decimals) = 0.004 SOL: 4 lamports per raw unit.
        let target = raw_price(4, 1_000, 6, 9).unwrap();
        let bin = bin_at_or_below(target, 20).unwrap();
        assert!(bin_price(bin, 20).unwrap() <= target);
        assert!(bin_price(bin + 1, 20).unwrap() > target);
    }
}
