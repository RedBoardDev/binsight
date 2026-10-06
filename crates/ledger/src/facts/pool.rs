//! A DLMM pool: its two tokens, its bin step, and the token its positions are valued in.

mod quote;

pub use quote::{PhysicalSide, QuoteConvention};

use binsight_solana::Address;

use super::token::TokenFacts;

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
    /// Selects USDC, then USDT, then SOL, on either physical side.
    ///
    /// Token kinds and decimals must already come from verified mint facts. Physical X/Y
    /// tokens and bin IDs remain unchanged; consumers apply this same display convention.
    pub fn quote_convention(&self) -> Option<QuoteConvention> {
        QuoteConvention::of(self)
    }

    /// The selected native valuation asset, using the same convention as prices and amounts.
    pub fn quote_asset(&self) -> Option<QuoteAsset> {
        self.quote_convention().map(QuoteConvention::asset)
    }
}
