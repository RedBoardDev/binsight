//! The figures of one closed position: its flows and PnL valued in SOL and dollars, and its
//! outcome.
//!
//! Every amount of a closed position is valued at the SOL/USD rate of its closing day. The
//! outcome (win, loss, breakeven) is read on the sign of the PnL in the pool's own quote token,
//! so a dollar-quoted position that gained dollars is a win even if SOL rose more. A position with
//! a movement valued without its bin price is partial.

use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use jiff::Timestamp;

use super::figure::{Figure, Reason, Reasons};
use super::valued::{Valued, value_quote};
use crate::facts::{ClosedPositionFacts, PnlMethod, PoolFacts, QuoteUnits, SolUsdRates};

/// How a closed position ended, read on the sign of its PnL in the pool's quote token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Outcome {
    /// It gained.
    Win,
    /// It lost.
    Loss,
    /// It ended exactly even.
    Breakeven,
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
    /// withdrawn + claimed fees − invested.
    pub lp_pnl: Figure<Valued>,
    /// The FIFO market PnL, when the position was measured that way.
    pub market_pnl: Option<Figure<Valued>>,
    /// The PnL of the position: the market PnL when known, otherwise the liquidity PnL.
    pub pnl: Figure<Valued>,
    /// How it ended.
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
        let value = |amount: QuoteUnits| value_leaf(amount, position, pool, rates);
        let market_pnl = match position.method {
            PnlMethod::Fifo { market_pnl } => Some(value(market_pnl)?),
            PnlMethod::Pool => None,
        };
        Ok(Self {
            invested: value(position.invested)?,
            withdrawn: value(position.withdrawn)?,
            claimed_fees: value(position.claimed_fees)?,
            pnl: value(native_pnl)?,
            lp_pnl: value(lp_pnl)?,
            market_pnl,
            outcome: Outcome::of(native_pnl),
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
            _ => Self::Breakeven,
        }
    }
}

/// withdrawn + claimed fees − invested, in the quote token.
///
/// # Errors
///
/// Returns [`AmountError::Overflow`] when the sum overflows.
pub fn lp_pnl(position: &ClosedPositionFacts) -> Result<QuoteUnits, AmountError> {
    position
        .withdrawn
        .0
        .checked_add(position.claimed_fees.0)
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
    [position.invested, position.withdrawn, position.claimed_fees]
        .iter()
        .all(|amount| amount.0 == 0)
}

/// One amount of a closed position, valued at its closing day's rate, partial when one of its
/// movements had no bin price.
fn value_leaf(
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
    let figure = value_quote(amount, asset, rates.on(position.closed_at))?;
    if position.unpriced_movements == 0 {
        return Ok(figure);
    }
    let reason = Reason::UnpricedLeg {
        position: position.id,
    };
    Ok(figure.degraded(Exactness::Partial, Reasons::from([reason])))
}
