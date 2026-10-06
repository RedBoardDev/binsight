//! References to the things figures are about: wallets (with their label and color), tokens
//! (with their metadata and logo) and pools.

use binsight_core::price::Price;
use binsight_core::units::Decimals;
use binsight_ledger::facts::QuoteAsset;
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

/// A token as the screens show it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenRef {
    /// The mint.
    pub mint: Address,
    /// The ticker, when known.
    pub symbol: Option<String>,
    /// The full name, when known.
    pub name: Option<String>,
    /// The decimals of the mint.
    pub decimals: Decimals,
    /// How to draw its logo.
    pub logo: TokenLogo,
}

/// How a client draws a token's logo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenLogo {
    /// The SOL coin, which clients draw themselves.
    Sol,
    /// An image binsight serves; `version` changes whenever the image does.
    Image {
        /// A short fingerprint of the image, for cache-busting.
        version: String,
    },
    /// No logo: clients draw a monogram.
    None,
}

/// A pool in its selected display orientation; unsupported pools retain physical X/Y.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolRef {
    /// The pool address.
    pub address: Address,
    /// Its bin step, in basis points.
    pub bin_step: u16,
    /// The token whose price moves.
    pub base: TokenRef,
    /// The token prices are expressed in.
    pub quote: TokenRef,
    /// What the quote token is, when binsight can value it.
    pub quote_asset: Option<QuoteAsset>,
}

/// A unit price and the token it is expressed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PriceView {
    /// Whole quote tokens per whole base token.
    pub value: Price,
    /// The quote token.
    pub quote: QuoteAsset,
}
