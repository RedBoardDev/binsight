//! The bin chart of an open position: one bar per bin, grouped when there are too many.

use binsight_core::ratio::Ratio;
use binsight_core::units::RawTokenAmount;
use binsight_dlmm::math::{mul_shr_64, price_from_bin};
use binsight_ledger::facts::{BinLiquidity, OpenPositionFacts, PoolFacts};

use crate::portfolio::query::refs::bin_price;
use crate::portfolio::views::{BinBar, BinChart, MAX_BIN_BARS};

/// The chart of `position`'s liquidity in `pool`.
pub(super) fn bin_chart(position: &OpenPositionFacts, pool: &PoolFacts) -> BinChart {
    let group_size = position.bins.len().div_ceil(MAX_BIN_BARS).max(1);
    let groups: Vec<BinLiquidity> = position.bins.chunks(group_size).filter_map(merge).collect();
    let values: Vec<u128> = groups
        .iter()
        .map(|bin| value_at_own_price(bin, pool))
        .collect();
    let largest = values.iter().copied().max().unwrap_or(0);
    let bars = groups
        .iter()
        .zip(values)
        .map(|(bin, value)| BinBar {
            bin_id: bin.bin_id,
            price: bin_price(pool, bin.bin_id),
            base: bin.base,
            quote: bin.quote,
            height: height(value, largest),
        })
        .collect();
    BinChart {
        active_bin_id: position.active_bin_id,
        lower_bin_id: position.lower_bin_id,
        upper_bin_id: position.upper_bin_id,
        bars,
    }
}

/// One bar for a group of consecutive bins: the first bin's id and the sum of their amounts.
fn merge(bins: &[BinLiquidity]) -> Option<BinLiquidity> {
    let first = bins.first()?;
    let sum = |amount: fn(&BinLiquidity) -> RawTokenAmount| {
        // Raw amounts of one position are far below 2^128: saturating can never change a sum.
        let total = bins
            .iter()
            .fold(0_u128, |total, bin| total.saturating_add(amount(bin).0));
        RawTokenAmount(total)
    };
    Some(BinLiquidity {
        bin_id: first.bin_id,
        base: sum(|bin| bin.base),
        quote: sum(|bin| bin.quote),
    })
}

/// The value of a bin's liquidity in quote units, at the bin's own price (its depth).
fn value_at_own_price(bin: &BinLiquidity, pool: &PoolFacts) -> u128 {
    let base_value = price_from_bin(bin.bin_id, pool.bin_step)
        .ok()
        .and_then(|price| mul_shr_64(bin.base.0, price))
        .unwrap_or(0);
    base_value.saturating_add(bin.quote.0)
}

/// `value / largest`, from 0 to 1.
fn height(value: u128, largest: u128) -> Ratio {
    let to_i128 = |amount: u128| i128::try_from(amount).unwrap_or(i128::MAX);
    Ratio::of(to_i128(value), to_i128(largest)).unwrap_or_default()
}
