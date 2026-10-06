//! The movements of a position as its timeline shows them, newest first, page by page.

use binsight_core::units::{Decimals, RawTokenAmount};
use binsight_ledger::facts::{EventOrder, PositionEventKind};
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::valued::Money;
use binsight_solana::{Address, Signature};

use crate::portfolio::views::PriceView;

/// What a movement did, in the order of the movements of one transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MovementKind {
    /// The position account was created, independently of any deposit.
    Open,
    /// Liquidity was added.
    Add,
    /// Liquidity was withdrawn by a rebalance.
    RebalanceWithdrawal,
    /// Liquidity was redeposited by a rebalance.
    RebalanceDeposit,
    /// A farming reward was claimed in its own mint.
    RewardClaim,
    /// Part of the liquidity was withdrawn.
    Remove,
    /// Fees were claimed.
    Claim,
    /// The position account was closed, independently of any withdrawal.
    Close,
}

/// One movement of a position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionEventView {
    /// Where it sits in the timeline: newer movements have greater orders.
    pub order: EventOrder,
    /// Its transaction (several movements can share one).
    pub signature: Signature,
    /// What it did.
    pub kind: MovementKind,
    /// The displayed base token it moved; the source movement remains physical X/Y.
    pub base: Option<TokenQuantity>,
    /// The displayed quote token it moved; its decimals follow that selected token.
    pub quote: Option<TokenQuantity>,
    /// A reward claimed in its own mint, with its raw amount preserved.
    pub reward: Option<RewardMovement>,
    /// The movement's share of the position figure, converted at the position's rate.
    pub value: Option<Figure<Money>>,
    /// The bin price of its transaction, when known.
    pub price: Option<PriceView>,
    /// The range it set, when it opened or rebalanced the position.
    pub range: Option<RangeBounds>,
}

/// An amount of a token and the decimals to show it with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenQuantity {
    /// The amount, in raw units.
    pub amount: RawTokenAmount,
    /// The decimals of the token.
    pub decimals: Decimals,
}

/// The bins of a range and their prices.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RangeBounds {
    /// The lowest bin.
    pub lower_bin_id: i32,
    /// The highest bin.
    pub upper_bin_id: i32,
    /// The lower numeric displayed price bound, when the quote can be valued.
    pub lower: Option<PriceView>,
    /// The upper numeric displayed price bound, when the quote can be valued.
    pub upper: Option<PriceView>,
}

/// A page of movements, newest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventPage {
    /// The movements.
    pub items: Vec<PositionEventView>,
    /// The order to read the next page after, when older movements remain.
    pub next: Option<EventOrder>,
}

impl From<&PositionEventKind> for MovementKind {
    fn from(kind: &PositionEventKind) -> Self {
        match kind {
            PositionEventKind::Created { .. } => Self::Open,
            PositionEventKind::Add(_) => Self::Add,
            PositionEventKind::RebalanceDeposit { .. } => Self::RebalanceDeposit,
            PositionEventKind::RebalanceWithdrawal(_) => Self::RebalanceWithdrawal,
            PositionEventKind::RewardClaim(_) => Self::RewardClaim,
            PositionEventKind::Remove(_) => Self::Remove,
            PositionEventKind::Claim(_) => Self::Claim,
            PositionEventKind::Closed => Self::Close,
        }
    }
}

/// The proof of a reward claim, independent of whether its metadata or price is known.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RewardMovement {
    /// The mint paid by the reward program.
    pub mint: Address,
    /// An integer quantity of raw units; no decimals are assumed.
    pub raw_amount: RawTokenAmount,
    /// The pool's reward program index.
    pub reward_index: u64,
}
