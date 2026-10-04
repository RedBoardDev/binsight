//! References to the things figures are about: wallets (with their label and color).

use binsight_solana::Address;

use crate::portfolio::wallet_label::WalletLabel;

/// A tracked wallet as the screens name it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletRef {
    /// The wallet address.
    pub address: Address,
    /// Its label (never empty).
    pub label: WalletLabel,
    /// Its color in the charts and legends.
    pub color: WalletColor,
}

/// One of the eight colors a wallet can have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum WalletColor {
    /// The first wallet color.
    Wallet1,
    /// The second wallet color.
    Wallet2,
    /// The third wallet color.
    Wallet3,
    /// The fourth wallet color.
    Wallet4,
    /// The fifth wallet color.
    Wallet5,
    /// The sixth wallet color.
    Wallet6,
    /// The seventh wallet color.
    Wallet7,
    /// The eighth wallet color.
    Wallet8,
}
