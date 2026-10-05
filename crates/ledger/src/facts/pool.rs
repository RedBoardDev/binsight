//! A DLMM pool: its two tokens, its bin step, and the token its positions are valued in.

use binsight_solana::Address;

use super::token::{TokenFacts, TokenKind};

/// A DLMM pool, oriented as base (token X) and quote (token Y).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolFacts {
    /// The pool (`LbPair`) address.
    pub address: Address,
    /// The bin step, in basis points.
    pub bin_step: u16,
    /// The token whose price moves (token X).
    pub base: TokenFacts,
    /// The token prices are expressed in (token Y).
    pub quote: TokenFacts,
}

/// The token a pool's position amounts are counted in, when binsight can value it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum QuoteAsset {
    /// The pool is quoted in SOL: amounts are lamports.
    Sol,
    /// The pool is quoted in USDC: amounts are micro-dollars.
    Usdc,
    /// The pool is quoted in USDT: amounts are micro-dollars.
    Usdt,
}

impl PoolFacts {
    /// The quote asset of the pool, or `None` when its quote token is neither SOL nor a dollar
    /// stablecoin (binsight cannot value its positions then).
    pub fn quote_asset(&self) -> Option<QuoteAsset> {
        match self.quote.kind {
            TokenKind::Sol => Some(QuoteAsset::Sol),
            TokenKind::Usdc => Some(QuoteAsset::Usdc),
            TokenKind::Usdt => Some(QuoteAsset::Usdt),
            TokenKind::Other => None,
        }
    }
}
