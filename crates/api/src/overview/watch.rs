//! What deserves the owner's attention, on the wire.

use binsight_engine::portfolio::views;
use jiff::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

use crate::contract::{DecimalString, PoolRef, TokenRef, WalletRef};

/// A token held without a price, left out of the net worth.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct UnpricedHolding {
    /// Who holds it.
    pub(crate) wallet: WalletRef,
    /// The token.
    pub(crate) token: TokenRef,
    /// How much, in whole tokens.
    pub(crate) amount: DecimalString,
}

/// Something that deserves the owner's attention, tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum WatchItem {
    /// A position is out of its range.
    OutOfRange {
        /// The position id.
        position: String,
        /// Its pool.
        pool: PoolRef,
        /// Its wallet.
        wallet: WalletRef,
        /// Whether the price is above or below the range.
        side: RangeSide,
        /// Since when, when known.
        since: Option<Timestamp>,
    },
    /// A wallet holds a token without a price.
    UnpricedToken {
        /// The wallet.
        wallet: WalletRef,
        /// The token.
        token: TokenRef,
        /// How much, in whole tokens.
        amount: DecimalString,
    },
    /// A wallet is importing its history.
    Importing {
        /// The wallet.
        wallet: WalletRef,
        /// How far it is, in percent.
        progress: DecimalString,
        /// How long it should still take, in seconds, when known.
        eta_seconds: Option<u64>,
    },
    /// A wallet is behind the chain.
    Lagging {
        /// The wallet.
        wallet: WalletRef,
        /// By how many seconds, when known.
        lag_seconds: Option<u64>,
    },
    /// The month will spend more credits than its budget.
    CreditsOverBudget {
        /// The credits the month will have spent.
        projected: u64,
        /// The budget.
        budget: u64,
    },
}

/// Where the price is against a range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RangeSide {
    /// Above: the position holds only quote token.
    Above,
    /// Below: the position holds only base token.
    Below,
}

impl From<&views::UnpricedHolding> for UnpricedHolding {
    fn from(holding: &views::UnpricedHolding) -> Self {
        Self {
            wallet: (&holding.wallet).into(),
            token: (&holding.token).into(),
            amount: whole_tokens(holding),
        }
    }
}

impl From<&views::WatchItem> for WatchItem {
    fn from(item: &views::WatchItem) -> Self {
        match item {
            views::WatchItem::OutOfRange {
                position,
                pool,
                wallet,
                is_above,
                since,
            } => Self::OutOfRange {
                position: position.to_string(),
                pool: pool.as_ref().into(),
                wallet: wallet.into(),
                side: if *is_above {
                    RangeSide::Above
                } else {
                    RangeSide::Below
                },
                since: *since,
            },
            views::WatchItem::UnpricedToken(holding) => Self::UnpricedToken {
                wallet: (&holding.wallet).into(),
                token: (&holding.token).into(),
                amount: whole_tokens(holding),
            },
            views::WatchItem::Importing {
                wallet,
                progress,
                eta_seconds,
            } => Self::Importing {
                wallet: wallet.into(),
                progress: (*progress).into(),
                eta_seconds: *eta_seconds,
            },
            views::WatchItem::Lagging {
                wallet,
                lag_seconds,
            } => Self::Lagging {
                wallet: wallet.into(),
                lag_seconds: *lag_seconds,
            },
            views::WatchItem::CreditsOverBudget { projected, budget } => Self::CreditsOverBudget {
                projected: *projected,
                budget: *budget,
            },
        }
    }
}

/// The amount of a holding in whole tokens, with the token's decimals.
fn whole_tokens(holding: &views::UnpricedHolding) -> DecimalString {
    DecimalString::from_canonical(binsight_core::decimal::format_units(
        holding.amount,
        holding.token.decimals,
    ))
}
