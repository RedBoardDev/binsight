//! The figures of one closed position: its flows and PnL valued in SOL and dollars, and its
//! outcome.
//!
//! Every amount of a closed position is valued at the SOL/USD rate of its closing day. The
//! outcome (win, loss, flat) is read on the exact sign of the PnL in the pool's own quote token,
//! so a dollar-quoted position that gained dollars is a win even if SOL rose more, and an empty
//! shell (nothing ever moved) is flat like a position that ended exactly even. When an unpriced
//! movement or reward hides that sign, the outcome is unknown: the position stays visible with
//! that outcome instead of a guessed one (see [`sign`]). A subtotal holding an unpriced movement
//! is partial.

use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use jiff::Timestamp;

mod sign;

pub(crate) use sign::PnlUncertainty;

use super::figure::{Figure, Reason, Reasons};
use super::valued::{Money, Valued, quote::native_money, value_quote_at};
use crate::facts::{
    ClosedPositionFacts, PnlMethod, PoolFacts, PositionHistory, QuoteConvention, QuoteUnits,
    SolUsdRates,
};

/// How a closed position ended, read on the exact sign of its PnL in the pool's quote token.
/// Every screen and count uses this one outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Outcome {
    /// It gained.
    Win,
    /// It lost.
    Loss,
    /// It ended exactly even, or never moved (an empty shell).
    Flat,
    /// Its sign cannot be told: a movement or a reward has no price.
    Unknown,
}

/// The valued figures of a closed position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedValuation {
    /// The value of every deposit.
    pub invested: Figure<Valued>,
    /// The value of every withdrawal.
    pub withdrawn: Figure<Valued>,
    /// The value of every fee claim.
    pub claimed_fees: Figure<Valued>,
    /// Rewards priced in their own token at the movement time, separately from swap fees.
    pub rewards: Figure<Valued>,
    /// withdrawn + claimed fees + rewards − invested.
    pub lp_pnl: Figure<Valued>,
    /// The FIFO market PnL, when the position was measured that way.
    pub market_pnl: Option<Figure<Valued>>,
    /// The PnL of the position: the market PnL when known, otherwise the liquidity PnL.
    pub pnl: Figure<Valued>,
    /// The same chosen PnL in its selected pool token, before currency conversion.
    pub native_pnl: Figure<Money>,
    /// The sign of its native PnL, or `Unknown` when unpriced movements or rewards hide it.
    pub outcome: Outcome,
    /// How long it was held, in seconds.
    pub held_seconds: i64,
    /// Whether nothing was ever deposited, withdrawn or claimed (an empty shell).
    pub is_shell: bool,
}

impl ClosedValuation {
    /// Values `position`, which provided liquidity to `pool`, at the rate of its closing day.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when an amount overflows.
    pub fn of(
        position: &ClosedPositionFacts,
        pool: &PoolFacts,
        rates: &SolUsdRates,
    ) -> Result<Self, AmountError> {
        let lp_pnl = lp_pnl(position)?;
        let native_pnl = match position.method {
            PnlMethod::Fifo { market_pnl } => market_pnl,
            PnlMethod::Pool => lp_pnl,
        };
        let reasons = Reasons::from([Reason::UnpricedLeg {
            position: position.id,
        }]);
        let has_gap = position.history != PositionHistory::Whole;
        let flow = |amount: QuoteUnits, unpriced: u32| -> Result<Figure<Valued>, AmountError> {
            let figure = value_known(amount, position, pool, rates)?;
            if unpriced == 0 && !has_gap {
                return Ok(figure);
            }
            Ok(figure.degraded(Exactness::Partial, reasons.clone()))
        };
        let unpriced = position.unpriced_movements;
        let signed = |figure: Figure<QuoteUnits>| -> Result<Figure<Valued>, AmountError> {
            let (amount, exactness, reasons) = figure.into_parts();
            let Some(amount) = amount else {
                return Ok(Figure::Unavailable { reasons });
            };
            Ok(value_known(amount, position, pool, rates)?.degraded(exactness, reasons))
        };
        let pnl = native_signed(native_pnl, position);
        let market_pnl = match position.method {
            PnlMethod::Fifo { market_pnl } => Some(signed(native_signed(market_pnl, position))?),
            PnlMethod::Pool => None,
        };
        Ok(Self {
            invested: flow(position.invested, unpriced.deposits)?,
            withdrawn: flow(position.withdrawn, unpriced.withdrawals)?,
            claimed_fees: flow(position.claimed_fees, unpriced.fee_claims)?,
            rewards: flow(position.rewards, position.unpriced_rewards)?,
            pnl: signed(pnl.clone())?,
            native_pnl: native_money(pnl, pool),
            lp_pnl: signed(native_signed(lp_pnl, position))?,
            market_pnl,
            outcome: uncertainty(position).outcome(native_pnl),
            held_seconds: held_seconds(position.opened_at, position.closed_at),
            is_shell: is_shell(position),
        })
    }
}

impl Outcome {
    /// The outcome of a PnL in the pool's quote token.
    pub fn of(pnl: QuoteUnits) -> Self {
        match pnl.0.signum() {
            1 => Self::Win,
            -1 => Self::Loss,
            _ => Self::Flat,
        }
    }
}

/// withdrawn + claimed fees + rewards − invested, in the quote token.
///
/// # Errors
///
/// Returns [`AmountError::Overflow`] when the sum overflows.
pub fn lp_pnl(position: &ClosedPositionFacts) -> Result<QuoteUnits, AmountError> {
    position
        .withdrawn
        .0
        .checked_add(position.claimed_fees.0)
        .and_then(|returned| returned.checked_add(position.rewards.0))
        .and_then(|returned| returned.checked_sub(position.invested.0))
        .map(QuoteUnits)
        .ok_or(AmountError::Overflow)
}

/// The seconds between two instants.
pub fn held_seconds(opened_at: Timestamp, closed_at: Timestamp) -> i64 {
    closed_at.duration_since(opened_at).as_secs()
}

/// Whether a position never moved any liquidity.
fn is_shell(position: &ClosedPositionFacts) -> bool {
    [
        position.invested,
        position.withdrawn,
        position.claimed_fees,
        position.rewards,
    ]
    .iter()
    .all(|amount| amount.0 == 0)
        && position.unpriced_movements.is_none()
        && position.unpriced_rewards == 0
        && position.history == PositionHistory::Whole
}

fn value_known(
    amount: QuoteUnits,
    position: &ClosedPositionFacts,
    pool: &PoolFacts,
    rates: &SolUsdRates,
) -> Result<Figure<Valued>, AmountError> {
    let Some(asset) = pool.quote_convention().map(QuoteConvention::asset) else {
        return Ok(Figure::unavailable(Reason::UnsupportedQuote {
            pool: pool.address,
        }));
    };
    value_quote_at(amount, asset, rates.on(position.closed_at))
}

/// Which way the PnL of `position` may lie from its known value.
fn uncertainty(position: &ClosedPositionFacts) -> PnlUncertainty {
    PnlUncertainty::of(
        position.unpriced_movements,
        position.unpriced_rewards,
        position.history,
    )
}

/// The signed source quality shared by native PnL and its eventual FX conversion.
fn native_signed(amount: QuoteUnits, position: &ClosedPositionFacts) -> Figure<QuoteUnits> {
    let exactness = uncertainty(position).exactness();
    if exactness == Exactness::Complete {
        return Figure::Complete(amount);
    }
    Figure::from_parts(
        amount,
        exactness,
        Reasons::from([Reason::UnpricedLeg {
            position: position.id,
        }]),
    )
}
