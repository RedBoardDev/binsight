//! An open position as last valued: its flows so far, its liquidity bin by bin and its fees.

use binsight_core::units::RawTokenAmount;
use binsight_solana::Address;
use jiff::Timestamp;

use super::position::{PositionId, QuoteUnits, Strategy};
use crate::report::figure::Figure;

/// An open position, valued at its pool's active bin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenPositionFacts {
    /// The identity of this life of the position.
    pub id: PositionId,
    /// The wallet that owns it.
    pub wallet: Address,
    /// The pool it provides liquidity to.
    pub pool: Address,
    /// Its strategy when one can be proved; `None` for weights or mixed strategies.
    pub strategy: Option<Strategy>,
    /// When it was created.
    pub opened_at: Timestamp,
    /// Deposits outside rebalances plus each rebalance's positive net contribution.
    pub invested: QuoteUnits,
    /// Withdrawals outside rebalances plus each rebalance's negative net contribution.
    pub withdrawn: QuoteUnits,
    /// The value of every fee claim so far.
    pub claimed_fees: QuoteUnits,
    /// Rewards valued at their own movement-time token price, separately from swap fees.
    pub rewards: QuoteUnits,
    /// Nonzero rewards whose own token price is unknown; the known reward sum leaves them out.
    pub unpriced_rewards: u32,
    /// The value of its liquidity now, at the active bin.
    pub value: Figure<QuoteUnits>,
    /// The value of the fees it could claim now.
    pub unclaimed_fees: Figure<QuoteUnits>,
    /// Whether total raw pool fees are proved nonzero, independently of their valuation.
    /// `Some(false)` requires complete zero raw X/Y fees, including pending and unsettled;
    /// `None` means their presence is unknown. A positive raw amount may value to zero.
    pub unclaimed_fee_presence: Option<bool>,
    /// The lowest bin of its range.
    pub lower_bin_id: i32,
    /// The highest bin of its range.
    pub upper_bin_id: i32,
    /// The pool's active bin when it was valued.
    pub active_bin_id: i32,
    /// Its liquidity in each bin of its range, lowest bin first.
    pub bins: Vec<BinLiquidity>,
    /// Since when the active bin is on its current side of the range (inside, above or below);
    /// `None` when it never moved since the opening.
    pub range_since: Option<Timestamp>,
    /// When the value and the fees were read.
    pub valued_at: Timestamp,
    /// How many movements had no bin price and were valued on their quote side only.
    pub unpriced_movements: u32,
    /// Rebalance groups with an unpriced half; their net contributions may change sign.
    pub unpriced_rebalances: u32,
}

/// The liquidity a position holds in one bin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BinLiquidity {
    /// The bin.
    pub bin_id: i32,
    /// Its amount of base token (token X), in raw units.
    pub base: RawTokenAmount,
    /// Its amount of quote token (token Y), in raw units.
    pub quote: RawTokenAmount,
}
