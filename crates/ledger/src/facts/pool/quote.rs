//! Choose one valuation token and display orientation without changing physical pool tokens.

use super::{PoolFacts, QuoteAsset};
use crate::facts::{TokenFacts, TokenKind};

/// One side of the physical DLMM pool; its bin IDs and raw price always stay in X/Y order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PhysicalSide {
    /// Token X (the physical base token).
    X,
    /// Token Y (the physical quote token).
    Y,
}

/// The selected valuation token and the physical side that holds it.
///
/// Callers provide a pool's verified token facts. Priority is SOL, then USDC, then USDT, on
/// either side, so a SOL/USDC position is valued in SOL like every other SOL pool. Equal
/// priority keeps Y. Amount and price conversions live in
/// [`crate::report::valued::quote`]; this selection never swaps physical bin IDs or raw amounts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct QuoteConvention {
    asset: QuoteAsset,
    side: PhysicalSide,
}

impl QuoteConvention {
    pub(super) fn of(pool: &PoolFacts) -> Option<Self> {
        for (kind, asset) in [
            (TokenKind::Sol, QuoteAsset::Sol),
            (TokenKind::Usdc, QuoteAsset::Usdc),
            (TokenKind::Usdt, QuoteAsset::Usdt),
        ] {
            if pool.quote.kind == kind {
                return Some(Self {
                    asset,
                    side: PhysicalSide::Y,
                });
            }
            if pool.base.kind == kind {
                return Some(Self {
                    asset,
                    side: PhysicalSide::X,
                });
            }
        }
        None
    }

    /// The token amounts are valued in.
    pub fn asset(self) -> QuoteAsset {
        self.asset
    }

    /// Which physical pool side holds the selected token.
    pub fn side(self) -> PhysicalSide {
        self.side
    }

    /// The token whose displayed price moves, opposite the selected quote token.
    ///
    /// Pass the same pool used by [`PoolFacts::quote_convention`]; this value carries no
    /// pool address and does not verify that identity.
    pub fn base_token(self, pool: &PoolFacts) -> &TokenFacts {
        match self.side {
            PhysicalSide::X => &pool.quote,
            PhysicalSide::Y => &pool.base,
        }
    }

    /// The selected token in which displayed prices and values are expressed.
    ///
    /// Pass the same pool used by [`PoolFacts::quote_convention`]; this value carries no
    /// pool address and does not verify that identity.
    pub fn quote_token(self, pool: &PoolFacts) -> &TokenFacts {
        match self.side {
            PhysicalSide::X => &pool.base,
            PhysicalSide::Y => &pool.quote,
        }
    }

    /// The physical bins to price for the lower and upper displayed price bounds.
    ///
    /// With X selected, prices decrease as physical IDs increase. This reverses only the
    /// lookup order; stored lower/upper/active bin IDs and the chart's bin order stay physical.
    pub fn price_bound_bins(self, lower: i32, upper: i32) -> (i32, i32) {
        match self.side {
            PhysicalSide::X => (upper, lower),
            PhysicalSide::Y => (lower, upper),
        }
    }
}
