//! A movement of a position: what one transaction did to it, with the tokens it moved and their
//! value at the bin price of that transaction.
//!
//! A position's movements add up to its figures: the deposits to what it invested, the
//! withdrawals to what it withdrew and the claims to its claimed fees. They also say where its
//! range was over time. This module defines them; it does not read them from transactions.

use binsight_core::units::RawTokenAmount;
use binsight_solana::Signature;
use jiff::Timestamp;

use super::position::{PositionId, QuoteUnits};

/// One movement of a position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionEventFact {
    /// The position it moved.
    pub position: PositionId,
    /// When its transaction happened.
    pub at: Timestamp,
    /// Its transaction.
    pub signature: Signature,
    /// The pool's active bin in that transaction, when the transaction says it: the price of
    /// the movement.
    pub active_bin_id: Option<i32>,
    /// What happened.
    pub kind: PositionEventKind,
}

/// What a movement did. The order of the variants is the order of the movements of one
/// transaction: a position opens before it is added to, and closes last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PositionEventKind {
    /// The position was created over a range, with its first deposit.
    Open {
        /// Its range.
        range: BinRange,
        /// What was deposited.
        deposit: TokenFlow,
    },
    /// Liquidity was added.
    Add(TokenFlow),
    /// The liquidity moved to another range.
    Rebalance {
        /// The new range.
        range: BinRange,
    },
    /// Part of the liquidity was withdrawn.
    Remove(TokenFlow),
    /// Fees were claimed.
    Claim(TokenFlow),
    /// The position was closed, with its last withdrawal.
    Close {
        /// What was withdrawn when closing.
        withdrawal: TokenFlow,
    },
}

/// The bins a position spreads its liquidity over, both included.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BinRange {
    /// The lowest bin.
    pub lower_bin_id: i32,
    /// The highest bin.
    pub upper_bin_id: i32,
}

/// Tokens that moved in or out of a position, and their value in the pool's quote token at the
/// bin price of the movement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct TokenFlow {
    /// The base token (token X), in raw units.
    pub base: RawTokenAmount,
    /// The quote token (token Y), in raw units.
    pub quote: RawTokenAmount,
    /// Their value in the quote token.
    pub value: QuoteUnits,
}

impl PositionEventKind {
    /// The tokens the movement moved, if it moved any.
    pub fn flow(&self) -> Option<TokenFlow> {
        match *self {
            Self::Open { deposit, .. } => Some(deposit),
            Self::Add(flow) | Self::Remove(flow) | Self::Claim(flow) => Some(flow),
            Self::Close { withdrawal } => Some(withdrawal),
            Self::Rebalance { .. } => None,
        }
    }

    /// The range the movement set, if it set one.
    pub fn range(&self) -> Option<BinRange> {
        match *self {
            Self::Open { range, .. } | Self::Rebalance { range } => Some(range),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RANGE: BinRange = BinRange {
        lower_bin_id: -10,
        upper_bin_id: 10,
    };

    const FLOW: TokenFlow = TokenFlow {
        base: RawTokenAmount(5),
        quote: RawTokenAmount(7),
        value: QuoteUnits(12),
    };

    #[test]
    fn gives_the_tokens_of_every_movement_but_a_rebalance() {
        let open = PositionEventKind::Open {
            range: RANGE,
            deposit: FLOW,
        };

        assert_eq!(open.flow(), Some(FLOW));
        assert_eq!(PositionEventKind::Claim(FLOW).flow(), Some(FLOW));
        assert_eq!(PositionEventKind::Rebalance { range: RANGE }.flow(), None);
    }

    #[test]
    fn gives_the_range_only_of_an_opening_or_a_rebalance() {
        let open = PositionEventKind::Open {
            range: RANGE,
            deposit: FLOW,
        };

        assert_eq!(open.range(), Some(RANGE));
        assert_eq!(
            PositionEventKind::Rebalance { range: RANGE }.range(),
            Some(RANGE)
        );
        assert_eq!(PositionEventKind::Remove(FLOW).range(), None);
    }

    #[test]
    fn orders_the_movements_of_one_transaction() {
        let close = PositionEventKind::Close { withdrawal: FLOW };

        assert!(PositionEventKind::Claim(FLOW) < close);
        assert!(
            PositionEventKind::Open {
                range: RANGE,
                deposit: FLOW
            } < PositionEventKind::Add(FLOW)
        );
    }
}
