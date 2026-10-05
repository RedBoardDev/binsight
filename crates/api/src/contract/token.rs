//! Tokens, pools and unit prices on the wire.

use binsight_engine::portfolio::views;
use binsight_ledger::facts::QuoteAsset;
use serde::Serialize;
use utoipa::ToSchema;

use super::decimal::DecimalString;

/// A token: its mint, its metadata when known, its decimals and how to draw its logo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct TokenRef {
    /// The mint (base58).
    pub(crate) mint: String,
    /// The ticker; `null` when unknown (clients show the short mint).
    pub(crate) symbol: Option<String>,
    /// The full name; `null` when unknown.
    pub(crate) name: Option<String>,
    /// The decimals of the mint, read on-chain.
    pub(crate) decimals: u8,
    /// How to draw its logo.
    pub(crate) logo: TokenLogo,
}

/// How a client draws a token's logo. Logos are always served by binsight itself, never by a
/// third party.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum TokenLogo {
    /// The SOL coin: clients draw it themselves.
    Sol,
    /// An image served by binsight, same-origin and versioned (cache it forever).
    Image {
        /// The image path, such as `/api/v1/tokens/<mint>/logo?v=<fingerprint>`.
        url: String,
    },
    /// No logo: clients draw a monogram.
    None,
}

/// A DLMM pool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct PoolRef {
    /// The pool address (base58).
    pub(crate) address: String,
    /// Its bin step, in basis points.
    pub(crate) bin_step: u16,
    /// The token whose price moves.
    pub(crate) base: TokenRef,
    /// The token prices are expressed in.
    pub(crate) quote: TokenRef,
    /// What the quote token is; `null` when binsight cannot value it.
    pub(crate) quote_kind: Option<QuoteKind>,
}

/// What a pool's quote token is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum QuoteKind {
    /// SOL.
    Sol,
    /// A dollar stablecoin.
    Stable,
}

/// The token a price is expressed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PriceQuote {
    /// SOL.
    Sol,
    /// USD Coin.
    Usdc,
    /// Tether USD.
    Usdt,
}

/// A unit price: quote tokens per base token, with at most twelve significant digits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Price {
    /// The price.
    pub(crate) amount: DecimalString,
    /// The token it is expressed in.
    pub(crate) quote: PriceQuote,
}

impl From<&views::TokenRef> for TokenRef {
    fn from(token: &views::TokenRef) -> Self {
        Self {
            mint: token.mint.to_string(),
            symbol: token.symbol.clone(),
            name: token.name.clone(),
            decimals: token.decimals.0,
            logo: match &token.logo {
                views::TokenLogo::Sol => TokenLogo::Sol,
                views::TokenLogo::Image { version } => TokenLogo::Image {
                    url: format!("/api/v1/tokens/{}/logo?v={version}", token.mint),
                },
                views::TokenLogo::None => TokenLogo::None,
            },
        }
    }
}

impl From<&views::PoolRef> for PoolRef {
    fn from(pool: &views::PoolRef) -> Self {
        Self {
            address: pool.address.to_string(),
            bin_step: pool.bin_step,
            base: (&pool.base).into(),
            quote: (&pool.quote).into(),
            quote_kind: pool.quote_asset.map(|asset| match asset {
                QuoteAsset::Sol => QuoteKind::Sol,
                QuoteAsset::Usdc | QuoteAsset::Usdt => QuoteKind::Stable,
            }),
        }
    }
}

impl From<views::PriceView> for Price {
    fn from(price: views::PriceView) -> Self {
        Self {
            amount: DecimalString::from_canonical(price.value.to_significant_string()),
            quote: match price.quote {
                QuoteAsset::Sol => PriceQuote::Sol,
                QuoteAsset::Usdc => PriceQuote::Usdc,
                QuoteAsset::Usdt => PriceQuote::Usdt,
            },
        }
    }
}
