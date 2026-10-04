//! A closed position: what went in and came out, in the pool's quote token, and how its PnL was
//! measured.

use binsight_solana::Address;
use jiff::Timestamp;

use super::position::{PositionId, QuoteUnits, Strategy};

/// One closed life of a position, summed from its movements.
///
/// Every movement is valued at the price of the bin of its own transaction, in the pool's quote
/// token. The liquidity PnL follows: withdrawn + claimed fees − invested.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedPositionFacts {
    /// The identity of this life of the position.
    pub id: PositionId,
    /// The wallet that owned it.
    pub wallet: Address,
    /// The pool it provided liquidity to.
    pub pool: Address,
    /// How its liquidity was spread.
    pub strategy: Strategy,
    /// When it was created.
    pub opened_at: Timestamp,
    /// When it was closed.
    pub closed_at: Timestamp,
    /// The value of every deposit.
    pub invested: QuoteUnits,
    /// The value of every withdrawal, the final one included.
    pub withdrawn: QuoteUnits,
    /// The value of every fee claim.
    pub claimed_fees: QuoteUnits,
    /// How the PnL of the position is measured.
    pub method: PnlMethod,
    /// How many movements had no bin price and were valued on their quote side only; any makes
    /// the position's figures a lower bound.
    pub unpriced_movements: u32,
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
