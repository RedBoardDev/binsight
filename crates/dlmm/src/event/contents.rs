//! What each event binsight models says, field by field, in domain types.
//!
//! Each struct holds the fields of one event (or of a family of events with the same shape) that
//! binsight needs, named as in the program's IDL. Token amounts are [`RawTokenAmount`]s, bins are
//! `i32` bin ids. This module only defines the shapes; [`super::layout`] reads them from bytes.

use binsight_core::units::RawTokenAmount;
use binsight_solana::Address;
use serde::Serialize;

use super::payload::amount;

/// A position created (`PositionCreate`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PositionCreated {
    /// The pool of the position.
    pub lb_pair: Address,
    /// The position account.
    pub position: Address,
    /// Its owner, who may differ from the signer (an operator can create it for them).
    pub owner: Address,
}

/// A position closed (`PositionClose`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PositionClosed {
    /// The position account.
    pub position: Address,
    /// Its owner.
    pub owner: Address,
}

/// Liquidity added to or removed from a position (`AddLiquidity`, `RemoveLiquidity`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LiquidityChanged {
    /// The pool.
    pub lb_pair: Address,
    /// The signer who moved the liquidity (the owner or an operator).
    pub from: Address,
    /// The position.
    pub position: Address,
    /// The amount of token X moved.
    #[serde(serialize_with = "amount")]
    pub amount_x: RawTokenAmount,
    /// The amount of token Y moved.
    #[serde(serialize_with = "amount")]
    pub amount_y: RawTokenAmount,
    /// The active bin of the pool at that moment.
    pub active_bin_id: i32,
}

/// Liquidity moved inside a position in one instruction (`Rebalancing`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Rebalanced {
    /// The pool.
    pub lb_pair: Address,
    /// The position.
    pub position: Address,
    /// Its owner.
    pub owner: Address,
    /// The active bin of the pool at that moment.
    pub active_bin_id: i32,
    /// Token X taken out of the bins it left.
    #[serde(serialize_with = "amount")]
    pub x_withdrawn_amount: RawTokenAmount,
    /// Token X put into the bins it now covers.
    #[serde(serialize_with = "amount")]
    pub x_added_amount: RawTokenAmount,
    /// Token Y taken out of the bins it left.
    #[serde(serialize_with = "amount")]
    pub y_withdrawn_amount: RawTokenAmount,
    /// Token Y put into the bins it now covers.
    #[serde(serialize_with = "amount")]
    pub y_added_amount: RawTokenAmount,
    /// The swap fees in token X the position had earned.
    #[serde(serialize_with = "amount")]
    pub x_fee_amount: RawTokenAmount,
    /// The swap fees in token Y the position had earned.
    #[serde(serialize_with = "amount")]
    pub y_fee_amount: RawTokenAmount,
    /// The farming rewards the position had earned, by reward index (0 and 1).
    #[serde(serialize_with = "super::payload::amounts")]
    pub rewards: [RawTokenAmount; 2],
}

/// The swap fees of a position paid to its owner (`ClaimFee`, `ClaimFee2`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct FeeClaimed {
    /// The pool.
    pub lb_pair: Address,
    /// The position.
    pub position: Address,
    /// Its owner.
    pub owner: Address,
    /// The fees paid in token X.
    #[serde(serialize_with = "amount")]
    pub fee_x: RawTokenAmount,
    /// The fees paid in token Y.
    #[serde(serialize_with = "amount")]
    pub fee_y: RawTokenAmount,
}

/// A farming reward of a position paid to its owner (`ClaimReward`, `ClaimReward2`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RewardClaimed {
    /// The pool.
    pub lb_pair: Address,
    /// The position.
    pub position: Address,
    /// Its owner.
    pub owner: Address,
    /// Which of the pool's rewards (0 or 1).
    pub reward_index: u64,
    /// The amount paid, in the reward's own token.
    #[serde(serialize_with = "amount")]
    pub total_reward: RawTokenAmount,
}

/// A swap against a pool (`Swap`, `Swap2Evt`): the fields both forms share.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Swapped {
    /// The pool.
    pub lb_pair: Address,
    /// The account that swapped (often an aggregator's authority, not a person).
    pub from: Address,
    /// The active bin before the swap.
    pub start_bin_id: i32,
    /// The active bin after the swap.
    pub end_bin_id: i32,
    /// The amount that went in.
    #[serde(serialize_with = "amount")]
    pub amount_in: RawTokenAmount,
    /// The amount that came out.
    #[serde(serialize_with = "amount")]
    pub amount_out: RawTokenAmount,
    /// Whether X went in and Y came out.
    pub swap_for_y: bool,
}

/// A limit order placed (`PlaceLimitOrderEvt`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LimitOrderPlaced {
    /// The pool.
    pub lb_pair: Address,
    /// The signer.
    pub sender: Address,
    /// The owner of the order.
    pub owner: Address,
    /// The limit order account.
    pub limit_order: Address,
    /// The active bin of the pool at that moment.
    pub active_id: i32,
    /// Whether the order sells token X (an ask) rather than token Y.
    pub is_ask_side: bool,
    /// The total amount placed, over every bin of the order.
    #[serde(serialize_with = "amount")]
    pub total_amount: RawTokenAmount,
}

/// A limit order cancelled (`CancelLimitOrderEvt`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LimitOrderCancelled {
    /// The pool.
    pub lb_pair: Address,
    /// The signer.
    pub from: Address,
    /// The limit order account.
    pub limit_order: Address,
    /// The amount of token X returned.
    #[serde(serialize_with = "amount")]
    pub amount_x: RawTokenAmount,
    /// The amount of token Y returned.
    #[serde(serialize_with = "amount")]
    pub amount_y: RawTokenAmount,
    /// The active bin of the pool at that moment.
    pub active_id: i32,
}

/// An empty limit order account closed (`CloseLimitOrderEvt`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LimitOrderClosed {
    /// The pool.
    pub lb_pair: Address,
    /// The owner of the order.
    pub owner: Address,
    /// The limit order account.
    pub limit_order: Address,
}

/// The fee charged on liquidity added to the active bin (`CompositionFee`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CompositionFeeCharged {
    /// The signer who added the liquidity.
    pub from: Address,
    /// The bin it was charged in.
    pub bin_id: i16,
    /// The fee in token X.
    #[serde(serialize_with = "amount")]
    pub token_x_fee_amount: RawTokenAmount,
    /// The fee in token Y.
    #[serde(serialize_with = "amount")]
    pub token_y_fee_amount: RawTokenAmount,
}

/// A position made longer or shorter (`IncreasePositionLength`, `DecreasePositionLength`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PositionLengthChanged {
    /// The pool.
    pub lb_pair: Address,
    /// The position.
    pub position: Address,
    /// Its owner.
    pub owner: Address,
    /// How many bins were added or removed.
    pub length: u16,
    /// On which side (the program's code: 0 for the lower side, 1 for the upper side).
    pub side: u8,
}
