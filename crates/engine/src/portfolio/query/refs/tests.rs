//! Selected display tokens, prices and quantities retain the exact physical source convention.

use binsight_core::price::Price;
use binsight_core::units::Decimals;
use binsight_ledger::facts::QuoteAsset;

use super::*;
use crate::portfolio::SnapshotFacts;

fn pool(x: TokenKind, y: TokenKind) -> PoolFacts {
    let token = |side, kind| TokenFacts {
        mint: Address::from_bytes([side; 32]),
        symbol: Some(format!("{kind:?}")),
        name: None,
        decimals: Decimals(if kind == TokenKind::Sol { 9 } else { 6 }),
        kind,
    };
    PoolFacts {
        address: Address::from_bytes([3; 32]),
        bin_step: 1_000,
        base: token(1, x),
        quote: token(2, y),
    }
}

/// At bin 0 a raw price of 1 is 1,000 USDC per SOL in both orientations, shown in SOL: a USDC
/// is worth 0.001 SOL.
#[test]
fn prices_the_same_sol_usdc_pair_in_sol_from_both_real_bin_zero_orientations() {
    for (x, y) in [
        (TokenKind::Sol, TokenKind::Usdc),
        (TokenKind::Usdc, TokenKind::Sol),
    ] {
        let pool = pool(x, y);
        let original = pool.clone();
        let snapshot = Snapshot::new(SnapshotFacts {
            pools: vec![pool.clone()],
            ..SnapshotFacts::default()
        })
        .unwrap();
        let displayed = pool_ref(&snapshot, pool.address).unwrap();
        assert_eq!(displayed.base.decimals, Decimals(6));
        assert_eq!(displayed.quote.decimals, Decimals::SOL);
        assert_eq!(displayed.quote_asset, Some(QuoteAsset::Sol));
        assert_eq!(
            bin_price(&pool, 0),
            Some(PriceView {
                value: Price(1_000_000_000_000_000),
                quote: QuoteAsset::Sol,
            })
        );
        assert_eq!(pool, original);
    }
}

#[test]
fn reverses_display_quantities_and_numeric_bounds_without_reversing_physical_ids() {
    let pool = pool(TokenKind::Sol, TokenKind::Usdc);
    assert_eq!(
        display_amounts(
            &pool,
            RawTokenAmount(1_000_000_000),
            RawTokenAmount(20_000_000)
        ),
        (RawTokenAmount(20_000_000), RawTokenAmount(1_000_000_000))
    );
    let (lower, upper) = range_prices(&pool, -1, 1);
    assert!(lower.unwrap().value < upper.unwrap().value);
    assert_eq!(lower, bin_price(&pool, 1));
    assert_eq!(upper, bin_price(&pool, -1));
}

#[test]
fn keeps_unsupported_physical_labels_and_quantities_without_a_financial_price() {
    let pool = pool(TokenKind::Other, TokenKind::Other);
    let (base, quote) = display_tokens(&pool);
    assert_eq!((base.mint, quote.mint), (pool.base.mint, pool.quote.mint));
    assert_eq!(
        display_amounts(&pool, RawTokenAmount(7), RawTokenAmount(11)),
        (RawTokenAmount(7), RawTokenAmount(11))
    );
    assert_eq!(bin_price(&pool, 0), None);
    assert_eq!(range_prices(&pool, -1, 1), (None, None));
}
