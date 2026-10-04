//! The facts [`super::position_activity`] reports about one transaction.
//!
//! Plain data: what moved, for which position, at which place in the transaction. Deciding whose
//! positions they are and what they are worth is the ledger's job; this module only names the
//! shapes.

use binsight_core::units::RawTokenAmount;
use binsight_solana::Address;
use binsight_solana::transaction::InstructionPosition;

use crate::event::Swapped;

/// Everything a transaction did to DLMM positions and pools.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TxActivity {
    /// Positions created and closed, in execution order.
    pub lifecycle: Vec<LifecycleFact>,
    /// Liquidity and fees that moved between positions and their owners, in execution order.
    pub movements: Vec<PositionMovement>,
    /// Farming rewards paid to the owners of positions, in execution order.
    pub reward_claims: Vec<RewardClaim>,
    /// Swaps against a pool, once each, for information: a swap routed through a pool stays a
    /// swap.
    pub pool_swaps: Vec<PoolSwap>,
    /// Whether the program did something this version of binsight does not know (an unknown
    /// event or instruction): the figures built on this transaction are then only partial.
    pub has_unknown_program_activity: bool,
}

/// A position created or closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleFact {
    /// A position account created.
    Created {
        /// The event that said so.
        at: InstructionPosition,
        /// The position account.
        position: Address,
        /// Its pool.
        pool: Address,
        /// Its owner, which may differ from the signer.
        owner: Address,
    },
    /// A position account closed.
    Closed {
        /// The event that said so.
        at: InstructionPosition,
        /// The position account.
        position: Address,
        /// Its owner.
        owner: Address,
    },
}

/// Tokens that moved between a position and its owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PositionMovement {
    /// The event it comes from.
    pub at: InstructionPosition,
    /// The position.
    pub position: Address,
    /// Its pool.
    pub pool: Address,
    /// What moved.
    pub kind: MovementKind,
    /// The amount of token X.
    pub x: RawTokenAmount,
    /// The amount of token Y.
    pub y: RawTokenAmount,
    /// The active bin at that moment, which prices the movement; `None` for a fee claim of the
    /// first form with no event of its pool to borrow a bin from.
    pub price_bin: Option<i32>,
}

/// What a [`PositionMovement`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MovementKind {
    /// Liquidity added by the owner.
    Deposit,
    /// Liquidity removed to the owner.
    Withdrawal,
    /// Liquidity added back by a rebalance.
    RebalanceDeposit,
    /// Liquidity taken out by a rebalance.
    RebalanceWithdrawal,
    /// Swap fees paid to the owner.
    FeeClaim,
}

/// A farming reward paid to the owner of a position, in the reward's own token.
///
/// A reward is usually a third token, neither X nor Y, so the pool's bin does not price it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RewardClaim {
    /// The event it comes from.
    pub at: InstructionPosition,
    /// The position.
    pub position: Address,
    /// Its pool.
    pub pool: Address,
    /// Which of the pool's rewards (0 or 1).
    pub reward_index: u64,
    /// The token paid, when the paying instruction names it. A rebalance that harvests a reward
    /// does not name it: the pool's own reward list does, for whoever reads the pool account.
    pub mint: Option<Address>,
    /// The amount paid.
    pub amount: RawTokenAmount,
}

/// A swap against a DLMM pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolSwap {
    /// The event it comes from (the second form, when the program emitted both).
    pub at: InstructionPosition,
    /// The pool.
    pub pool: Address,
    /// The swap itself.
    pub swap: Swapped,
}

/// A transaction whose events contradict what it did on chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ActivityError {
    /// A position account was closed without a `PositionClose` event.
    #[error("the position {position} was closed at {at:?} without a PositionClose event")]
    CloseWithoutEvent {
        /// The position.
        position: Address,
        /// The close instruction.
        at: InstructionPosition,
    },
    /// A position account was created without a `PositionCreate` event.
    #[error("the position {position} was created at {at:?} without a PositionCreate event")]
    OpenWithoutEvent {
        /// The position.
        position: Address,
        /// The instruction that created it.
        at: InstructionPosition,
    },
    /// An instruction that opens or closes a position without its position account.
    #[error("the position instruction at {at:?} names no position account")]
    MissingPositionAccount {
        /// The instruction.
        at: InstructionPosition,
    },
}
