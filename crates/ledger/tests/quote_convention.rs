//! Synthetic token facts exercise quote selection without changing physical amounts.
use binsight_core::price::Price;
use binsight_core::units::{Decimals, RawTokenAmount};
use binsight_dlmm::math::{BinMathError, Q64x64, price_from_bin};
use binsight_ledger::facts::{
    FlowValuation, PhysicalSide, PoolFacts, QuoteAsset, QuoteConvention, TokenFacts, TokenKind,
};
use binsight_ledger::report::valued::quote::QuoteMathError;
use binsight_solana::Address;
use proptest::prelude::*;

fn pool(x: TokenKind, y: TokenKind) -> PoolFacts {
    let token = |side, kind| TokenFacts {
        mint: Address::from_bytes([side; 32]),
        symbol: None,
        name: None,
        decimals: Decimals(9),
        kind,
    };
    PoolFacts {
        address: Address::from_bytes([3; 32]),
        bin_step: 25,
        base: token(1, x),
        quote: token(2, y),
    }
}

#[expect(
    clippy::unwrap_used,
    reason = "the synthetic pool always contains one SOL token"
)]
fn convention(side: PhysicalSide) -> QuoteConvention {
    match side {
        PhysicalSide::X => pool(TokenKind::Sol, TokenKind::Other),
        PhysicalSide::Y => pool(TokenKind::Other, TokenKind::Sol),
    }
    .quote_convention()
    .unwrap()
}

#[test]
fn prioritizes_sol_then_usdc_then_usdt_on_either_physical_side() {
    use PhysicalSide::{X, Y};
    use TokenKind::{Other, Sol, Usdc, Usdt};
    let cases = [
        (Other, Other, None),
        (Other, Sol, Some((QuoteAsset::Sol, Y))),
        (Other, Usdc, Some((QuoteAsset::Usdc, Y))),
        (Other, Usdt, Some((QuoteAsset::Usdt, Y))),
        (Sol, Other, Some((QuoteAsset::Sol, X))),
        (Sol, Sol, Some((QuoteAsset::Sol, Y))),
        (Sol, Usdc, Some((QuoteAsset::Sol, X))),
        (Sol, Usdt, Some((QuoteAsset::Sol, X))),
        (Usdc, Other, Some((QuoteAsset::Usdc, X))),
        (Usdc, Sol, Some((QuoteAsset::Sol, Y))),
        (Usdc, Usdc, Some((QuoteAsset::Usdc, Y))),
        (Usdc, Usdt, Some((QuoteAsset::Usdc, X))),
        (Usdt, Other, Some((QuoteAsset::Usdt, X))),
        (Usdt, Sol, Some((QuoteAsset::Sol, Y))),
        (Usdt, Usdc, Some((QuoteAsset::Usdc, Y))),
        (Usdt, Usdt, Some((QuoteAsset::Usdt, Y))),
    ];
    for (x, y, expected) in cases {
        let selected = pool(x, y)
            .quote_convention()
            .map(|quote| (quote.asset(), quote.side()));
        assert_eq!(selected, expected, "physical kinds {x:?}/{y:?}");
    }
}

#[test]
fn selects_display_tokens_without_swapping_physical_pool_tokens() {
    for side in [PhysicalSide::X, PhysicalSide::Y] {
        let pool = match side {
            PhysicalSide::X => pool(TokenKind::Sol, TokenKind::Other),
            PhysicalSide::Y => pool(TokenKind::Other, TokenKind::Sol),
        };
        let original = pool.clone();
        let selected = pool.quote_convention().unwrap();
        assert_eq!(selected.quote_token(&pool).kind, TokenKind::Sol);
        assert_eq!(selected.base_token(&pool).kind, TokenKind::Other);
        assert_eq!(pool, original);
    }
}

#[test]
fn leaves_the_existing_y_only_consumer_convention_unchanged_until_migration() {
    let pool = pool(TokenKind::Sol, TokenKind::Usdc);
    assert_eq!(pool.quote_asset(), Some(QuoteAsset::Usdc));
    assert_eq!(pool.quote_convention().unwrap().asset(), QuoteAsset::Sol);
}

#[test]
fn reverses_price_bound_lookups_when_x_is_selected_but_keeps_physical_bin_ids() {
    for side in [PhysicalSide::X, PhysicalSide::Y] {
        let selected = convention(side);
        let (lower_bin, upper_bin) = selected.price_bound_bins(-20, 40);
        assert_eq!(
            (lower_bin, upper_bin),
            if side == PhysicalSide::X {
                (40, -20)
            } else {
                (-20, 40)
            }
        );
        let price = |bin| {
            selected
                .unit_price(price_from_bin(bin, 25).unwrap(), Decimals(9), Decimals(9))
                .unwrap()
        };
        assert!(price(lower_bin) <= price(upper_bin));
    }
}

#[test]
fn values_x_and_y_in_the_selected_token_without_a_rounded_reciprocal() {
    let price = Q64x64(Q64x64::ONE.0 * 3);
    let x = convention(PhysicalSide::X)
        .value_raw(RawTokenAmount(7), RawTokenAmount(3), Some(price))
        .unwrap();
    let y = convention(PhysicalSide::Y)
        .value_raw(RawTokenAmount(7), RawTokenAmount(3), Some(price))
        .unwrap();
    assert_eq!(x.amount, RawTokenAmount(8));
    assert_eq!(y.amount, RawTokenAmount(24));
    assert_eq!(
        (x.valuation, y.valuation),
        (FlowValuation::Complete, FlowValuation::Complete)
    );
}

#[test]
fn preserves_quote_only_coverage_instead_of_inventing_a_missing_price() {
    for side in [PhysicalSide::X, PhysicalSide::Y] {
        let selected = convention(side);
        for (x, y) in [(0, 0), (7, 0), (0, 9), (7, 9)] {
            let (quote, other) = if side == PhysicalSide::X {
                (x, y)
            } else {
                (y, x)
            };
            let value = selected
                .value_raw(RawTokenAmount(x), RawTokenAmount(y), None)
                .unwrap();
            assert_eq!(value.amount, RawTokenAmount(quote));
            assert_eq!(
                value.valuation,
                if other == 0 {
                    FlowValuation::Complete
                } else {
                    FlowValuation::QuoteOnly
                }
            );
        }
    }
}

#[test]
fn rejects_a_supplied_zero_price_for_either_orientation_even_when_amounts_are_zero() {
    for side in [PhysicalSide::X, PhysicalSide::Y] {
        let selected = convention(side);
        assert_eq!(
            selected.value_raw(RawTokenAmount(0), RawTokenAmount(0), Some(Q64x64(0))),
            Err(QuoteMathError::ZeroPrice)
        );
        assert_eq!(
            selected.unit_price(Q64x64(0), Decimals(9), Decimals(9)),
            Err(BinMathError::ZeroPrice)
        );
    }
}

#[test]
fn refuses_conversion_and_sum_overflow_without_truncating_raw_amounts() {
    let max = RawTokenAmount(u128::MAX);
    let zero = RawTokenAmount(0);
    let one = RawTokenAmount(1);
    let x = convention(PhysicalSide::X);
    let y = convention(PhysicalSide::Y);
    assert_eq!(
        x.value_raw(zero, max, Some(Q64x64(Q64x64::ONE.0 - 1))),
        Err(QuoteMathError::Overflow)
    );
    assert_eq!(
        y.value_raw(max, zero, Some(Q64x64(Q64x64::ONE.0 * 2))),
        Err(QuoteMathError::Overflow)
    );
    assert_eq!(
        x.value_raw(max, one, Some(Q64x64::ONE)),
        Err(QuoteMathError::Overflow)
    );
    assert_eq!(
        y.value_raw(one, max, Some(Q64x64::ONE)),
        Err(QuoteMathError::Overflow)
    );
    assert_eq!(
        x.value_raw(zero, max, Some(Q64x64::ONE)).unwrap().amount,
        max
    );
    assert_eq!(
        y.value_raw(max, zero, Some(Q64x64::ONE)).unwrap().amount,
        max
    );
}

#[test]
fn uses_physical_decimals_and_the_original_price_for_display_only() {
    let raw = Q64x64(Q64x64::ONE.0 * 4);
    assert_eq!(
        convention(PhysicalSide::Y).unit_price(raw, Decimals(6), Decimals(9)),
        Ok(Price(4_000_000_000_000_000))
    );
    assert_eq!(
        convention(PhysicalSide::X).unit_price(raw, Decimals(6), Decimals(9)),
        Ok(Price(250_000_000_000_000_000_000))
    );
    let raw = Q64x64(Q64x64::ONE.0 + 1);
    assert_eq!(
        convention(PhysicalSide::X).unit_price(raw, Decimals(9), Decimals(9)),
        Ok(Price(999_999_999_999_999_999))
    );
}

#[test]
fn never_uses_a_zero_display_price_to_value_raw_amounts() {
    let selected = convention(PhysicalSide::X);
    let raw = Q64x64(u128::MAX);
    assert_eq!(
        selected.unit_price(raw, Decimals(9), Decimals(0)),
        Ok(Price(0))
    );
    let value = selected
        .value_raw(RawTokenAmount(0), RawTokenAmount(u128::MAX), Some(raw))
        .unwrap();
    assert_eq!(value.amount, RawTokenAmount(Q64x64::ONE.0));
    assert_eq!(value.valuation, FlowValuation::Complete);
}

proptest! {
    #[test]
    fn preserves_both_raw_sides_exactly_at_price_one(x: u64, y: u64) {
        let x = RawTokenAmount(u128::from(x));
        let y = RawTokenAmount(u128::from(y));
        let total = x.try_add(y).unwrap();
        for side in [PhysicalSide::X, PhysicalSide::Y] {
            let value = convention(side).value_raw(x, y, Some(Q64x64::ONE)).unwrap();
            prop_assert_eq!(value.amount, total);
            prop_assert_eq!(value.valuation, FlowValuation::Complete);
        }
    }
}
