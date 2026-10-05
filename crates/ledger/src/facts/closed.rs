//! A closed position: what went in and came out, in the pool's quote token, and how its PnL was
//! measured.

use binsight_solana::Address;
use jiff::Timestamp;

use super::position::{PositionId, QuoteUnits, Strategy};

/// One closed life of a position, summed from its movements.
///
/// Every movement is valued at the price of the bin of its own transaction, in the pool's quote
/// token. The liquidity PnL follows: withdrawn + claimed fees + rewards − invested.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedPositionFacts {
    /// The identity of this life of the position.
    pub id: PositionId,
    /// The wallet that owned it.
    pub wallet: Address,
    /// The pool it provided liquidity to.
    pub pool: Address,
    /// Its strategy when one can be proved; `None` for weights or mixed strategies.
    pub strategy: Option<Strategy>,
    /// When it was created.
    pub opened_at: Timestamp,
    /// When it was closed.
    pub closed_at: Timestamp,
    /// Deposits outside rebalances plus each rebalance's positive net contribution.
    pub invested: QuoteUnits,
    /// Withdrawals outside rebalances plus each rebalance's negative net contribution.
    pub withdrawn: QuoteUnits,
    /// The value of every fee claim.
    pub claimed_fees: QuoteUnits,
    /// Rewards valued at their own movement-time token price, separately from swap fees.
    pub rewards: QuoteUnits,
    /// Nonzero rewards whose own token price is unknown; the known reward sum leaves them out.
    pub unpriced_rewards: u32,
    /// How the PnL of the position is measured.
    pub method: PnlMethod,
    /// How many movements were valued on their quote side only. Positive flow subtotals are
    /// partial; signed PnL is estimated because the unknown amount may be a cost.
    pub unpriced_movements: u32,
    /// Rebalance groups with an unpriced half; their net contributions may change sign.
    pub unpriced_rebalances: u32,
}

/// How the PnL of a closed position is measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PnlMethod {
    /// Each movement marked at its bin price: the PnL is the liquidity PnL.
    Pool,
    /// The cost basis of the tokens went through a FIFO inventory, so the PnL also counts what
    /// the tokens deposited had cost and what the tokens withdrawn were sold for.
    Fifo {
        /// The market PnL, in the quote token.
        market_pnl: QuoteUnits,
    },
}
