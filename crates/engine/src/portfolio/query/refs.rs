//! Naming what figures are about: wallets, tokens, pools and bin prices, from the snapshot.

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::math::price_from_bin;
use binsight_ledger::facts::{PhysicalSide, PoolFacts, QuoteConvention, TokenFacts, TokenKind};
use binsight_solana::Address;

use crate::portfolio::read_error::ReadError;
use crate::portfolio::snapshot::Snapshot;
use crate::portfolio::views::{PoolRef, PriceView, TokenLogo, TokenLogoImage, TokenRef, WalletRef};

/// The wallet at `address`, or [`ReadError::WalletNotFound`] when it is not tracked.
pub(super) fn wallet_ref(snapshot: &Snapshot, address: Address) -> Result<WalletRef, ReadError> {
    snapshot
        .wallet_ref(address)
        .ok_or(ReadError::WalletNotFound(address))
}

/// How the screens show `token`.
pub(super) fn token_ref(snapshot: &Snapshot, token: &TokenFacts) -> TokenRef {
    let logo = match (token.kind, snapshot.logo(token.mint)) {
        (TokenKind::Sol, _) => TokenLogo::Sol,
        (_, Some(logo)) => TokenLogo::Image {
            version: logo.version.clone(),
        },
        (_, None) => TokenLogo::None,
    };
    TokenRef {
        mint: token.mint,
        symbol: token.symbol.clone(),
        name: token.name.clone(),
        decimals: token.decimals,
        logo,
    }
}

/// The pool at `address`, as the screens show it.
pub(super) fn pool_ref(snapshot: &Snapshot, address: Address) -> Result<PoolRef, ReadError> {
    let pool = snapshot.pool(address).ok_or(ReadError::MissingFact)?;
    let (base, quote) = display_tokens(pool);
    Ok(PoolRef {
        address,
        bin_step: pool.bin_step,
        base: token_ref(snapshot, base),
        quote: token_ref(snapshot, quote),
        quote_asset: pool.quote_asset(),
    })
}

/// The unit price of `bin_id` in `pool`, or `None` when the pool's quote cannot be valued or the
/// bin is beyond the range of prices.
pub(super) fn bin_price(pool: &PoolFacts, bin_id: i32) -> Option<PriceView> {
    let convention = pool.quote_convention()?;
    let raw = price_from_bin(bin_id, pool.bin_step).ok()?;
    let value = convention
        .unit_price(raw, pool.base.decimals, pool.quote.decimals)
        .ok()?;
    Some(PriceView {
        value,
        quote: convention.asset(),
    })
}

/// Display tokens follow the selected quote; unsupported pools retain physical X/Y labels.
pub(super) fn display_tokens(pool: &PoolFacts) -> (&TokenFacts, &TokenFacts) {
    pool.quote_convention()
        .map_or((&pool.base, &pool.quote), |quote| {
            (quote.base_token(pool), quote.quote_token(pool))
        })
}

/// Map physical quantities once, at the read-view boundary, to the displayed token order.
pub(super) fn display_amounts(
    pool: &PoolFacts,
    x: RawTokenAmount,
    y: RawTokenAmount,
) -> (RawTokenAmount, RawTokenAmount) {
    match pool.quote_convention().map(QuoteConvention::side) {
        Some(PhysicalSide::X) => (y, x),
        Some(PhysicalSide::Y) | None => (x, y),
    }
}

/// Numeric lower/upper prices use selected lookups while the range IDs stay physical.
pub(super) fn range_prices(
    pool: &PoolFacts,
    lower: i32,
    upper: i32,
) -> (Option<PriceView>, Option<PriceView>) {
    let (lower, upper) = pool
        .quote_convention()
        .map_or((lower, upper), |quote| quote.price_bound_bins(lower, upper));
    (bin_price(pool, lower), bin_price(pool, upper))
}

/// The stored logo of the token at `mint`.
///
/// # Errors
///
/// Returns [`ReadError::LogoNotFound`] when no logo is stored for it.
pub fn token_logo(snapshot: &Snapshot, mint: Address) -> Result<TokenLogoImage, ReadError> {
    snapshot
        .logo(mint)
        .map(|logo| logo.image.clone())
        .ok_or(ReadError::LogoNotFound(mint))
}

#[cfg(test)]
mod tests;
