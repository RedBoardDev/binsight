//! A token as the accounting knows it: its mint, its decimals and what it is for valuation.

use binsight_core::units::Decimals;
use binsight_solana::Address;

/// A token mint and what binsight knows about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenFacts {
    /// The mint address.
    pub mint: Address,
    /// The ticker, such as `JUP`; `None` when no metadata is known.
    pub symbol: Option<String>,
    /// The full name, such as `Jupiter`; `None` when no metadata is known.
    pub name: Option<String>,
    /// The decimals of the mint, always read on-chain (never from third-party metadata).
    pub decimals: Decimals,
    /// What the token is for valuation.
    pub kind: TokenKind,
}

/// What a token is, for valuation: SOL and the dollar stablecoins are valued by rule, anything
/// else needs a price.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TokenKind {
    /// Wrapped SOL, worth exactly its amount in lamports.
    Sol,
    /// USD Coin, counted as one dollar.
    Usdc,
    /// Tether USD, counted as one dollar.
    Usdt,
    /// Any other token.
    Other,
}
