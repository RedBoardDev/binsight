//! A movement of a position: what one transaction did to it, with the tokens it moved and their
//! value at the bin price of that transaction.
//!
//! A position's movements add up to its figures: the deposits to what it invested, the
//! withdrawals to what it withdrew and the claims to its claimed fees. They also say where its
//! range was over time. This module defines them; it does not read them from transactions.

use binsight_core::units::RawTokenAmount;
use binsight_solana::transaction::InstructionPosition;
use binsight_solana::{Address, Signature};
use jiff::Timestamp;

use super::position::{PositionId, QuoteUnits};

/// One movement of a position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionEventFact {
    /// The position it moved.
    pub position: PositionId,
    /// When its transaction happened (the block time, to the second).
    pub at: Timestamp,
    /// Where it sits in the chain: several movements can share a second, or a transaction.
    pub order: ChainOrder,
    /// Its transaction.
    pub signature: Signature,
    /// The pool's active bin in that transaction, when the transaction says it: the price of
    /// the movement.
    pub active_bin_id: Option<i32>,
    /// What happened.
    pub kind: PositionEventKind,
}

/// Where a movement sits in the chain: its block, its transaction in the block and its place
/// among the movements of that transaction. Unique for every movement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ChainOrder {
    /// The slot of its block.
    pub slot: u64,
    /// The index of its transaction in the block.
    pub transaction_index: u32,
    /// Its index among the movements its transaction made.
    pub event_index: u32,
}

/// The order of the movements of a position: by place in the chain. The
/// timeline sorts with it and its pages start after it, so the two never disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EventOrder {
    /// The place in the chain, which decides the order independently of block time.
    pub chain: ChainOrder,
    /// A deterministic tie-breaker for sources synthesizing transaction indices.
    pub signature: Signature,
    /// The block time, for displaying the movement.
    pub at: Timestamp,
}

impl PositionEventFact {
    /// Its place in its position's timeline.
    pub fn sort_key(&self) -> EventOrder {
        EventOrder {
            at: self.at,
            chain: self.order,
            signature: self.signature,
        }
    }
}

/// A lifecycle event or a movement of one position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PositionEventKind {
    /// Its account was created, possibly without a deposit or a known range.
    Created {
        /// The range from instruction arguments, when known.
        range: Option<BinRange>,
    },
    /// Liquidity was added outside a rebalance.
    Add(TokenFlow),
    /// Liquidity was redeposited by one rebalance.
    RebalanceDeposit {
        /// Its full raw transfer, counted whole in what the position invested.
        movement: RebalanceFlow,
        /// The new range, when instruction arguments supply it.
        range: Option<BinRange>,
    },
    /// Liquidity was withdrawn by one rebalance.
    RebalanceWithdrawal(RebalanceFlow),
    /// Liquidity was withdrawn outside a rebalance.
    Remove(TokenFlow),
    /// Swap fees were claimed.
    Claim(TokenFlow),
    /// A farming reward was claimed in its own token.
    RewardClaim(RewardFlow),
    /// Its account was closed; any preceding withdrawal is a separate movement.
    Closed,
}

/// The bins a position spreads its liquidity over, both included.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BinRange {
    /// The lowest bin.
    pub lower_bin_id: i32,
    /// The highest bin.
    pub upper_bin_id: i32,
}

/// The raw pool tokens moved, and their quote value at the transaction's bin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct TokenFlow {
    /// Base token X, in raw units.
    pub base: RawTokenAmount,
    /// Quote token Y, in raw units.
    pub quote: RawTokenAmount,
    /// Their known value in quote units; unpriced legs are tracked by the position.
    pub value: QuoteUnits,
    /// Which transferred amounts are included in the known quote value.
    pub valuation: FlowValuation,
}

/// How much of a pool-token flow was valued, independently of bin metadata being present.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum FlowValuation {
    /// Both transferred pool tokens were priced.
    #[default]
    Complete,
    /// Only the quote transfer was priced; a nonzero base transfer is still unpriced.
    QuoteOnly,
}

/// One half of a rebalance, identified independently of other rebalances in the transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct RebalanceFlow {
    /// The position of its Rebalancing event; both halves share it.
    pub instruction: InstructionPosition,
    /// The full transfer, counted whole like any deposit or withdrawal.
    pub flow: TokenFlow,
}

/// A reward paid in a third token; a pool's bin never invents its price.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct RewardFlow {
    /// The reward token's mint, resolved by the journal's pool snapshot.
    pub mint: Address,
    /// The amount paid, in raw token units.
    pub amount: RawTokenAmount,
    /// Which reward program of the pool paid it.
    pub reward_index: u64,
    /// Its value in the pool's quote at the movement time, only when its own price is known.
    pub value: Option<QuoteUnits>,
}

impl PositionEventKind {
    /// The full raw pool-token transfer, apart from rewards in their own mint.
    pub fn flow(&self) -> Option<TokenFlow> {
        match *self {
            Self::Add(flow) | Self::Remove(flow) | Self::Claim(flow) => Some(flow),
            Self::RebalanceDeposit { movement, .. } | Self::RebalanceWithdrawal(movement) => {
                Some(movement.flow)
            }
            Self::Created { .. } | Self::RewardClaim(_) | Self::Closed => None,
        }
    }

    /// The range set by the instruction, when it supplied one.
    pub fn range(&self) -> Option<BinRange> {
        match *self {
            Self::Created { range } | Self::RebalanceDeposit { range, .. } => range,
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn represents_empty_creation_and_closure_without_any_transfer() {
        let created = PositionEventKind::Created { range: None };
        assert_eq!(created.flow(), None);
        assert_eq!(created.range(), None);
        assert_eq!(PositionEventKind::Closed.flow(), None);
        assert_eq!(PositionEventKind::Closed.range(), None);
    }
}
