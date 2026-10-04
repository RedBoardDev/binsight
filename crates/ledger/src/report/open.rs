//! The figures of one open position: its flows, value, fees and PnL valued at the spot rate, and
//! where the price stands in its range.
//!
//! The open PnL is everything the position returned or holds minus what it cost: withdrawn +
//! claimed fees + value + unclaimed fees − invested. The fees of an open position are what it
//! claimed plus what it could claim now. Above its range a position holds only quote token; below,
//! only base token.

use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use binsight_core::price::Price;
use binsight_core::ratio::{Percent, RatioError};

use super::figure::{Figure, Reason, Reasons};
use super::valued::{Valued, value_quote};
use crate::facts::{OpenPositionFacts, PoolFacts, QuoteUnits, SolUsdRates};

/// Where the active bin stands against a position's range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RangeStatus {
    /// Inside the range: the position earns fees.
    InRange,
    /// Above the range: the position holds only quote token.
    Above,
    /// Below the range: the position holds only base token.
    Below,
}

/// What a position holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Composition {
    /// Both tokens.
    Mixed,
    /// Only the base token.
    AllBase,
    /// Only the quote token.
    AllQuote,
}

/// The valued figures of an open position, at the spot rate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenValuation {
    /// The value of every deposit so far.
    pub invested: Figure<Valued>,
    /// The value of every withdrawal so far.
    pub withdrawn: Figure<Valued>,
    /// invested − withdrawn.
    pub net_invested: Figure<Valued>,
    /// The value of every fee claim so far.
    pub claimed_fees: Figure<Valued>,
    /// The value of the liquidity now.
    pub value: Figure<Valued>,
    /// The value of the fees it could claim now.
    pub unclaimed_fees: Figure<Valued>,
    /// claimed + unclaimed fees.
    pub fees: Figure<Valued>,
    /// withdrawn + claimed fees + value + unclaimed fees − invested.
    pub pnl: Figure<Valued>,
    /// Where the active bin stands against the range.
    pub range: RangeStatus,
    /// What the position holds.
    pub composition: Composition,
}

impl OpenValuation {
    /// Values `position`, which provides liquidity to `pool`, at the spot rate.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when an amount overflows.
    pub fn of(
        position: &OpenPositionFacts,
        pool: &PoolFacts,
        rates: &SolUsdRates,
    ) -> Result<Self, AmountError> {
        let value = |amount: QuoteUnits| value_leaf(amount, position, pool, rates);
        Ok(Self {
            invested: value(position.invested)?,
            withdrawn: value(position.withdrawn)?,
            net_invested: value(native_sum(&[position.invested], &[position.withdrawn])?)?,
            claimed_fees: value(position.claimed_fees)?,
            value: value(position.value)?,
            unclaimed_fees: value(position.unclaimed_fees)?,
            fees: value(native_sum(
                &[position.claimed_fees, position.unclaimed_fees],
                &[],
            )?)?,
            pnl: value(open_pnl(position)?)?,
            range: range_status(position),
            composition: composition(position),
        })
    }
}

/// withdrawn + claimed fees + value + unclaimed fees − invested, in the quote token.
///
/// # Errors
///
/// Returns [`AmountError::Overflow`] when the sum overflows.
pub fn open_pnl(position: &OpenPositionFacts) -> Result<QuoteUnits, AmountError> {
    let returned = [
        position.withdrawn,
        position.claimed_fees,
        position.value,
        position.unclaimed_fees,
    ];
    native_sum(&returned, &[position.invested])
}

/// How far the price can fall to the bottom of the range, and rise to its top, as percentages
/// of the current price (negative once outside the range).
///
/// # Errors
///
/// Returns [`RatioError`] when a price does not fit or the current price is zero.
pub fn range_margins(
    current: Price,
    lower: Price,
    upper: Price,
) -> Result<(Percent, Percent), RatioError> {
    let signed = |price: Price| i128::try_from(price.0).map_err(|_| RatioError::Overflow);
    let (current, lower, upper) = (signed(current)?, signed(lower)?, signed(upper)?);
    let down = current.checked_sub(lower).ok_or(RatioError::Overflow)?;
    let up = upper.checked_sub(current).ok_or(RatioError::Overflow)?;
    Ok((Percent::of(down, current)?, Percent::of(up, current)?))
}

/// Where the active bin stands against the range.
fn range_status(position: &OpenPositionFacts) -> RangeStatus {
    if position.active_bin_id > position.upper_bin_id {
        RangeStatus::Above
    } else if position.active_bin_id < position.lower_bin_id {
        RangeStatus::Below
    } else {
        RangeStatus::InRange
    }
}

/// `Σ added − Σ removed`, in the quote token.
fn native_sum(added: &[QuoteUnits], removed: &[QuoteUnits]) -> Result<QuoteUnits, AmountError> {
    let mut total: i128 = 0;
    for amount in added {
        total = total.checked_add(amount.0).ok_or(AmountError::Overflow)?;
    }
    for amount in removed {
        total = total.checked_sub(amount.0).ok_or(AmountError::Overflow)?;
    }
    Ok(QuoteUnits(total))
}

/// What the position's bins hold.
fn composition(position: &OpenPositionFacts) -> Composition {
    let has_base = position.bins.iter().any(|bin| bin.base.0 > 0);
    let has_quote = position.bins.iter().any(|bin| bin.quote.0 > 0);
    match (has_base, has_quote) {
        (true, false) => Composition::AllBase,
        (false, true) => Composition::AllQuote,
        _ => Composition::Mixed,
    }
}

/// One amount of an open position, valued at the spot rate, partial when one of its movements
/// had no bin price.
fn value_leaf(
    amount: QuoteUnits,
    position: &OpenPositionFacts,
    pool: &PoolFacts,
    rates: &SolUsdRates,
) -> Result<Figure<Valued>, AmountError> {
    let Some(asset) = pool.quote_asset() else {
        return Ok(Figure::unavailable(Reason::UnsupportedQuote {
            pool: pool.address,
        }));
    };
    let figure = value_quote(amount, asset, rates.spot)?;
    if position.unpriced_movements == 0 {
        return Ok(figure);
    }
    let reason = Reason::UnpricedLeg {
        position: position.id,
    };
    Ok(figure.degraded(Exactness::Partial, Reasons::from([reason])))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HALF: u128 = 500_000_000_000_000_000;
    const ONE: u128 = 1_000_000_000_000_000_000;
    const TWO: u128 = 2_000_000_000_000_000_000;

    #[test]
    fn measures_the_margins_against_the_current_price() {
        let (down, up) = range_margins(Price(ONE), Price(HALF), Price(TWO)).unwrap();
        assert_eq!(down.to_decimal_string(), "50");
        assert_eq!(up.to_decimal_string(), "100");
    }

    #[test]
    fn gives_a_negative_margin_outside_the_range() {
        let (down, up) = range_margins(Price(TWO), Price(HALF), Price(ONE)).unwrap();
        assert_eq!(down.to_decimal_string(), "75");
        assert_eq!(up.to_decimal_string(), "-50");
    }
}
