//! The bin chart of an open position, with checked depth at every bin's own price.

use binsight_core::error::AmountError;
use binsight_core::ratio::Ratio;
use binsight_core::units::RawTokenAmount;
use binsight_dlmm::math::{mul_shr_64, price_from_bin};
use binsight_ledger::facts::{BinLiquidity, OpenPositionFacts, PoolFacts};

use crate::portfolio::query::refs::bin_price;
use crate::portfolio::read_error::ReadError;
use crate::portfolio::views::{BinBar, BinChart, MAX_BIN_BARS};

/// A displayed group's raw amounts and depth, summed at the original bins' individual prices.
struct BinGroup {
    liquidity: BinLiquidity,
    value: RawTokenAmount,
}

/// The chart of `position`'s liquidity in `pool`.
pub(super) fn bin_chart(
    position: &OpenPositionFacts,
    pool: &PoolFacts,
) -> Result<BinChart, ReadError> {
    let group_size = position.bins.len().div_ceil(MAX_BIN_BARS).max(1);
    let groups = position
        .bins
        .chunks(group_size)
        .map(|bins| merge(bins, pool))
        .collect::<Result<Vec<_>, _>>()?;
    let largest = RawTokenAmount(groups.iter().map(|group| group.value.0).max().unwrap_or(0));
    let bars = groups
        .iter()
        .map(|group| {
            let bin = &group.liquidity;
            Ok(BinBar {
                bin_id: bin.bin_id,
                price: bin_price(pool, bin.bin_id),
                base: bin.base,
                quote: bin.quote,
                height: height(group.value, largest)?,
            })
        })
        .collect::<Result<_, ReadError>>()?;
    Ok(BinChart {
        active_bin_id: position.active_bin_id,
        lower_bin_id: position.lower_bin_id,
        upper_bin_id: position.upper_bin_id,
        bars,
    })
}

/// The first bin identifies a group; grouping never reprices its other bins at that price.
fn merge(bins: &[BinLiquidity], pool: &PoolFacts) -> Result<BinGroup, ReadError> {
    let first = bins.first().ok_or(ReadError::MissingFact)?;
    let mut group = BinGroup {
        liquidity: BinLiquidity {
            bin_id: first.bin_id,
            base: RawTokenAmount(0),
            quote: RawTokenAmount(0),
        },
        value: RawTokenAmount(0),
    };
    for bin in bins {
        group.liquidity.base = group.liquidity.base.try_add(bin.base)?;
        group.liquidity.quote = group.liquidity.quote.try_add(bin.quote)?;
        group.value = group.value.try_add(value_at_own_price(bin, pool)?)?;
    }
    Ok(group)
}

/// The depth of one physical bin in raw quote units, at that bin's own physical price.
fn value_at_own_price(bin: &BinLiquidity, pool: &PoolFacts) -> Result<RawTokenAmount, ReadError> {
    let price =
        price_from_bin(bin.bin_id, pool.bin_step).map_err(|_| ReadError::BinOutOfRange {
            pool: pool.address,
            bin_id: bin.bin_id,
        })?;
    let base_value = mul_shr_64(bin.base.0, price).ok_or(AmountError::Overflow)?;
    Ok(RawTokenAmount(base_value).try_add(bin.quote)?)
}

/// `value / largest`; zero is known only for a group whose depth is proved zero.
fn height(value: RawTokenAmount, largest: RawTokenAmount) -> Result<Ratio, ReadError> {
    if value.0 == 0 && largest.0 == 0 {
        return Ok(Ratio(0));
    }
    let value = i128::try_from(value.0).map_err(|_| AmountError::Overflow)?;
    let largest = i128::try_from(largest.0).map_err(|_| AmountError::Overflow)?;
    Ok(Ratio::of(value, largest)?)
}

#[cfg(test)]
mod tests;
