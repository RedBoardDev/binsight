//! The movements of a position as its timeline shows them, newest first, page by page.

use binsight_core::units::{Decimals, RawTokenAmount};
use binsight_ledger::facts::PositionEventKind;
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::valued::Money;
use binsight_solana::Signature;
use jiff::Timestamp;

use crate::portfolio::views::PriceView;

/// What a movement did, in the order of the movements of one transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MovementKind {
    /// The position was created, with its first deposit.
    Open,
    /// Liquidity was added.
    Add,
    /// The liquidity moved to another range.
    Rebalance,
    /// Part of the liquidity was withdrawn.
    Remove,
    /// Fees were claimed.
    Claim,
    /// The position was closed, with its last withdrawal.
    Close,
}

/// One movement of a position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionEventView {
    /// Where it sits in the timeline.
    pub key: EventKey,
    /// The base token it moved, when it moved tokens.
    pub base: Option<TokenQuantity>,
    /// The quote token it moved, when it moved tokens.
    pub quote: Option<TokenQuantity>,
    /// The value of what it moved, at the bin price of its transaction.
    pub value: Option<Figure<Money>>,
    /// The bin price of its transaction, when known.
    pub price: Option<PriceView>,
    /// The range it set, when it opened or rebalanced the position.
    pub range: Option<RangeBounds>,
}

/// The place of a movement in a position's timeline: newer movements have greater keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EventKey {
    /// When its transaction happened.
    pub at: Timestamp,
    /// Its transaction.
    pub signature: Signature,
    /// What it did.
    pub kind: MovementKind,
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
    /// The price of the lowest bin, when the pool's quote can be valued.
    pub lower: Option<PriceView>,
    /// The price of the highest bin, when the pool's quote can be valued.
    pub upper: Option<PriceView>,
}

/// A page of movements, newest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventPage {
    /// The movements.
    pub items: Vec<PositionEventView>,
    /// The key to read the next page after, when older movements remain.
    pub next: Option<EventKey>,
}

impl From<&PositionEventKind> for MovementKind {
    fn from(kind: &PositionEventKind) -> Self {
        match kind {
            PositionEventKind::Open { .. } => Self::Open,
            PositionEventKind::Add(_) => Self::Add,
            PositionEventKind::Rebalance { .. } => Self::Rebalance,
            PositionEventKind::Remove(_) => Self::Remove,
            PositionEventKind::Claim(_) => Self::Claim,
            PositionEventKind::Close { .. } => Self::Close,
        }
    }
}
