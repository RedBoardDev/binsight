//! A tracked wallet as every screen names it.

use binsight_engine::portfolio::views;
use serde::Serialize;
use utoipa::ToSchema;

/// A tracked wallet: its address, its label and its color.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct WalletRef {
    /// The wallet address (base58).
    pub(crate) address: String,
    /// Its label: never empty, at most 10 characters (the short address when the owner gave none).
    // Utoipa requires literal bounds; keep this aligned with MAX_WALLET_LABEL_CHARS.
    #[schema(min_length = 1, max_length = 10)]
    pub(crate) label: String,
    /// Its color in charts and legends.
    pub(crate) color: WalletColor,
}

/// One of the eight wallet colors of the theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) enum WalletColor {
    /// The first wallet color.
    #[serde(rename = "wallet_1")]
    Wallet1,
    /// The second wallet color.
    #[serde(rename = "wallet_2")]
    Wallet2,
    /// The third wallet color.
    #[serde(rename = "wallet_3")]
    Wallet3,
    /// The fourth wallet color.
    #[serde(rename = "wallet_4")]
    Wallet4,
    /// The fifth wallet color.
    #[serde(rename = "wallet_5")]
    Wallet5,
    /// The sixth wallet color.
    #[serde(rename = "wallet_6")]
    Wallet6,
    /// The seventh wallet color.
    #[serde(rename = "wallet_7")]
    Wallet7,
    /// The eighth wallet color.
    #[serde(rename = "wallet_8")]
    Wallet8,
}

impl From<&views::WalletRef> for WalletRef {
    fn from(wallet: &views::WalletRef) -> Self {
        Self {
            address: wallet.address.to_string(),
            label: wallet.label.to_string(),
            color: wallet.color.into(),
        }
    }
}

impl From<views::WalletColor> for WalletColor {
    fn from(color: views::WalletColor) -> Self {
        match color {
            views::WalletColor::Wallet1 => Self::Wallet1,
            views::WalletColor::Wallet2 => Self::Wallet2,
            views::WalletColor::Wallet3 => Self::Wallet3,
            views::WalletColor::Wallet4 => Self::Wallet4,
            views::WalletColor::Wallet5 => Self::Wallet5,
            views::WalletColor::Wallet6 => Self::Wallet6,
            views::WalletColor::Wallet7 => Self::Wallet7,
            views::WalletColor::Wallet8 => Self::Wallet8,
        }
    }
}
