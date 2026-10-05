//! The figures of one closed position: its flows and PnL valued in SOL and dollars, and its
//! outcome.
//!
//! Every amount of a closed position is valued at the SOL/USD rate of its closing day. The
//! outcome (win, loss, flat) is read on the exact sign of the PnL in the pool's own quote token,
//! so a dollar-quoted position that gained dollars is a win even if SOL rose more, and an empty
//! shell (nothing ever moved) is flat like a position that ended exactly even. A position with a
//! unpriced movement has partial positive flow subtotals and estimated signed PnL.

use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use jiff::Timestamp;

use super::figure::{Figure, Reason, Reasons};
use super::valued::{Valued, value_quote_at};
use crate::facts::{ClosedPositionFacts, PnlMethod, PoolFacts, QuoteUnits, SolUsdRates};

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
    /// Its proved native PnL sign; `None` when unpriced movements or rewards prevent proving it.
    pub outcome: Option<Outcome>,
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
        let value = |amount: QuoteUnits| value_leaf(amount, position, pool, rates);
        let signed = |amount| {
            let figure = value(amount)?;
            let missing = if position.unpriced_movements > 0 || position.unpriced_rebalances > 0 {
                Exactness::Estimated
            } else {
                Exactness::Partial
            };
            if position.unpriced_movements == 0
                && position.unpriced_rebalances == 0
                && position.unpriced_rewards == 0
            {
                Ok(figure)
            } else {
                Ok(figure.degraded(
                    missing,
                    Reasons::from([Reason::UnpricedLeg {
                        position: position.id,
                    }]),
                ))
            }
        };
        let flow = |amount| {
            let figure = value(amount)?;
            if position.unpriced_rebalances == 0 {
                Ok(figure)
            } else {
                Ok(figure.degraded(
                    Exactness::Estimated,
                    Reasons::from([Reason::UnpricedLeg {
                        position: position.id,
                    }]),
                ))
            }
        };
        let mut rewards = value_known(position.rewards, position, pool, rates)?;
        if position.unpriced_rewards > 0 {
            rewards = rewards.degraded(
                Exactness::Partial,
                Reasons::from([Reason::UnpricedLeg {
                    position: position.id,
                }]),
            );
        }
        let market_pnl = match position.method {
            PnlMethod::Fifo { market_pnl } => Some(signed(market_pnl)?),
            PnlMethod::Pool => None,
        };
        Ok(Self {
            invested: flow(position.invested)?,
            withdrawn: flow(position.withdrawn)?,
            claimed_fees: value(position.claimed_fees)?,
            rewards,
            pnl: signed(native_pnl)?,
            lp_pnl: signed(lp_pnl)?,
            market_pnl,
            outcome: proven_outcome(position, native_pnl),
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
        && position.unpriced_movements == 0
        && position.unpriced_rebalances == 0
        && position.unpriced_rewards == 0
}

/// One amount of a closed position, valued at its closing day's rate, partial when one of its
/// movements had no bin price.
fn value_leaf(
    amount: QuoteUnits,
    position: &ClosedPositionFacts,
    pool: &PoolFacts,
    rates: &SolUsdRates,
) -> Result<Figure<Valued>, AmountError> {
    let figure = value_known(amount, position, pool, rates)?;
    if position.unpriced_movements == 0 {
        return Ok(figure);
    }
    let reason = Reason::UnpricedLeg {
        position: position.id,
    };
    Ok(figure.degraded(Exactness::Partial, Reasons::from([reason])))
}

fn value_known(
    amount: QuoteUnits,
    position: &ClosedPositionFacts,
    pool: &PoolFacts,
    rates: &SolUsdRates,
) -> Result<Figure<Valued>, AmountError> {
    let Some(asset) = pool.quote_asset() else {
        return Ok(Figure::unavailable(Reason::UnsupportedQuote {
            pool: pool.address,
        }));
    };
    value_quote_at(amount, asset, rates.on(position.closed_at))
}

/// Keeps the sole outcome enum, while refusing to invent the sign of an unpriced native PnL.
fn proven_outcome(position: &ClosedPositionFacts, native_pnl: QuoteUnits) -> Option<Outcome> {
    if position.unpriced_movements > 0 || position.unpriced_rebalances > 0 {
        return None;
    }
    if position.unpriced_rewards > 0 && native_pnl.0 <= 0 {
        return None;
    }
    Some(Outcome::of(native_pnl))
}
