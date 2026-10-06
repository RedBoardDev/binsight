//! The figures of one open position: its flows, value, fees and PnL valued at the spot rate, and
//! where the price stands in its range.
//!
//! The open PnL is everything the position returned or holds minus what it cost: withdrawn +
//! claimed fees + rewards + value + unclaimed fees − invested. The fees of an open position are what it
//! claimed plus what it could claim now. Displayed range and composition follow the selected
//! quote convention; liquidity bin IDs and raw X/Y amounts remain physical.

use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use binsight_core::price::Price;
use binsight_core::ratio::{Percent, RatioError};

mod native;

pub use native::open_pnl;

use native::{native_fees, native_sum};

use super::figure::{Figure, Reason, Reasons};
use super::valued::{Money, Valued, quote::native_money, value_quote};
use crate::facts::{
    OpenPositionFacts, PhysicalSide, PoolFacts, QuoteConvention, QuoteUnits, SolUsdRates,
    WalletFacts,
};

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
    /// Rewards valued at their own movement-time prices, separately from swap fees.
    pub rewards: Figure<Valued>,
    /// The value of the liquidity now.
    pub value: Figure<Valued>,
    /// The value of the fees it could claim now.
    pub unclaimed_fees: Figure<Valued>,
    /// claimed + unclaimed fees.
    pub fees: Figure<Valued>,
    /// withdrawn + claimed fees + rewards + value + unclaimed fees − invested.
    pub pnl: Figure<Valued>,
    /// The same PnL in its selected pool token, before currency conversion.
    pub native_pnl: Figure<Money>,
    /// Where the active bin stands against the range.
    pub range: RangeStatus,
    /// What the position holds.
    pub composition: Composition,
}

impl OpenValuation {
    /// Marks historical flows partial during a wallet import.
    /// Differences are estimated because an omitted deposit or withdrawal can change either
    /// sign; their known value is not a lower bound. Current balances remain observed.
    #[must_use]
    pub fn with_history(mut self, wallet: &WalletFacts) -> Self {
        let reasons = super::figure::history_reasons([wallet], None);
        if reasons.is_empty() {
            return self;
        }
        self.invested = self.invested.degraded(Exactness::Partial, reasons.clone());
        self.withdrawn = self.withdrawn.degraded(Exactness::Partial, reasons.clone());
        self.net_invested = self
            .net_invested
            .degraded(Exactness::Estimated, reasons.clone());
        self.claimed_fees = self
            .claimed_fees
            .degraded(Exactness::Partial, reasons.clone());
        self.rewards = self.rewards.degraded(Exactness::Partial, reasons.clone());
        self.fees = self.fees.degraded(Exactness::Partial, reasons.clone());
        self.pnl = self.pnl.degraded(Exactness::Estimated, reasons.clone());
        self.native_pnl = self.native_pnl.degraded(Exactness::Estimated, reasons);
        self
    }

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
        let reasons = Reasons::from([Reason::UnpricedLeg {
            position: position.id,
        }]);
        let flow = |amount: QuoteUnits, unpriced: u32| -> Result<Figure<Valued>, AmountError> {
            let figure = value_current(Figure::Complete(amount), pool, rates)?;
            if unpriced == 0 {
                return Ok(figure);
            }
            Ok(figure.degraded(Exactness::Partial, reasons.clone()))
        };
        let unpriced = position.unpriced_movements;
        let mut net_invested = flow(native_sum(&[position.invested], &[position.withdrawn])?, 0)?;
        if unpriced.deposits > 0 || unpriced.withdrawals > 0 {
            net_invested = net_invested.degraded(
                Exactness::Estimated,
                Reasons::from([Reason::UnpricedLeg {
                    position: position.id,
                }]),
            );
        }
        let pnl = open_pnl(position)?;
        Ok(Self {
            invested: flow(position.invested, unpriced.deposits)?,
            withdrawn: flow(position.withdrawn, unpriced.withdrawals)?,
            net_invested,
            claimed_fees: flow(position.claimed_fees, unpriced.fee_claims)?,
            rewards: flow(position.rewards, position.unpriced_rewards)?,
            value: value_current(position.value.clone(), pool, rates)?,
            unclaimed_fees: value_current(position.unclaimed_fees.clone(), pool, rates)?,
            fees: value_current(native_fees(position)?, pool, rates)?,
            pnl: value_current(pnl.clone(), pool, rates)?,
            native_pnl: native_money(pnl, pool),
            range: range_status(position, pool),
            composition: composition(position, pool),
        })
    }
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
fn range_status(position: &OpenPositionFacts, pool: &PoolFacts) -> RangeStatus {
    let is_inverse = pool
        .quote_convention()
        .is_some_and(|quote| quote.side() == PhysicalSide::X);
    if (!is_inverse && position.active_bin_id > position.upper_bin_id)
        || (is_inverse && position.active_bin_id < position.lower_bin_id)
    {
        RangeStatus::Above
    } else if (!is_inverse && position.active_bin_id < position.lower_bin_id)
        || (is_inverse && position.active_bin_id > position.upper_bin_id)
    {
        RangeStatus::Below
    } else {
        RangeStatus::InRange
    }
}

/// What the position's bins hold.
fn composition(position: &OpenPositionFacts, pool: &PoolFacts) -> Composition {
    let has_x = position.bins.iter().any(|bin| bin.base.0 > 0);
    let has_y = position.bins.iter().any(|bin| bin.quote.0 > 0);
    let (has_base, has_quote) = match pool.quote_convention().map(QuoteConvention::side) {
        Some(PhysicalSide::X) => (has_y, has_x),
        Some(PhysicalSide::Y) | None => (has_x, has_y),
    };
    match (has_base, has_quote) {
        (true, false) => Composition::AllBase,
        (false, true) => Composition::AllQuote,
        _ => Composition::Mixed,
    }
}

fn value_current(
    amount: Figure<QuoteUnits>,
    pool: &PoolFacts,
    rates: &SolUsdRates,
) -> Result<Figure<Valued>, AmountError> {
    let (amount, exactness, mut reasons) = amount.into_parts();
    let Some(asset) = pool.quote_convention().map(QuoteConvention::asset) else {
        reasons.insert(Reason::UnsupportedQuote { pool: pool.address });
        return Ok(Figure::Unavailable { reasons });
    };
    let Some(amount) = amount else {
        return Ok(Figure::Unavailable { reasons });
    };
    Ok(value_quote(amount, asset, rates.spot)?.degraded(exactness, reasons))
}

#[cfg(test)]
mod tests;
