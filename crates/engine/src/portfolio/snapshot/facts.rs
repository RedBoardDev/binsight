//! What a source of figures hands over to build a snapshot.

use binsight_ledger::facts::{
    ClosedPositionFacts, OpenPnlMark, OpenPositionFacts, PoolFacts, SolUsdRates, TokenFacts,
    WalletEntry, WalletFacts, WalletHoldings,
};
use binsight_solana::Address;

use crate::portfolio::views::{TokenLogoImage, WalletColor, WalletSync};
use crate::portfolio::wallet_label::WalletLabel;

/// A tracked wallet: its facts, how the owner named it, what it holds and how it is synchronized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackedWallet {
    /// What the accounting knows about it.
    pub facts: WalletFacts,
    /// Its label.
    pub label: WalletLabel,
    /// Its color.
    pub color: WalletColor,
    /// What it holds outside positions.
    pub holdings: WalletHoldings,
    /// How far it is synchronized.
    pub sync: WalletSync,
}

/// Everything a snapshot is built from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SnapshotFacts {
    /// The tracked wallets, in the order they were added.
    pub wallets: Vec<TrackedWallet>,
    /// Every pool a position of a tracked wallet used.
    pub pools: Vec<PoolFacts>,
    /// The tokens held outside pools (so they can be named), such as unpriced holdings.
    pub tokens: Vec<TokenFacts>,
    /// The token logos binsight has stored.
    pub logos: Vec<TokenLogoFacts>,
    /// Every closed position.
    pub closed: Vec<ClosedPositionFacts>,
    /// Every open position.
    pub open: Vec<OpenPositionFacts>,
    /// Every wallet entry outside positions.
    pub entries: Vec<WalletEntry>,
    /// Every open-PnL mark.
    pub marks: Vec<OpenPnlMark>,
    /// The SOL/USD rates.
    pub rates: SolUsdRates,
}

/// A token logo binsight serves, and the fingerprint that versions its URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenLogoFacts {
    /// The token's mint.
    pub mint: Address,
    /// The image.
    pub image: TokenLogoImage,
    /// A short fingerprint of the image; it changes when the image does.
    pub version: String,
}
