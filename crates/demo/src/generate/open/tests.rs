//! Synthetic allocations are rebuilt in physical axes from the selected native amount.

use super::*;
use binsight_core::units::Decimals;
use binsight_dlmm::math::{Q64x64, price_from_bin};
use binsight_ledger::facts::{PoolFacts, TokenFacts, TokenKind};

fn pool(selected_x: bool) -> PoolFacts {
    let token = |byte, kind, decimals| TokenFacts {
        mint: Address::from_bytes([byte; 32]),
        symbol: None,
        name: None,
        kind,
        decimals,
    };
    let (sol, stable) = (
        token(1, TokenKind::Sol, Decimals::SOL),
        token(2, TokenKind::Usdc, Decimals(6)),
    );
    // SOL is the selected quote, so it sits on the physical side under test.
    let (base, quote) = if selected_x {
        (sol, stable)
    } else {
        (stable, sol)
    };
    PoolFacts {
        address: Address::from_bytes([3; 32]),
        bin_step: 1_000,
        base,
        quote,
    }
}

#[test]
fn reconstructs_both_physical_orientations_at_the_same_snapshot_price() {
    for selected_x in [false, true] {
        let pool = pool(selected_x);
        let convention = pool.quote_convention().unwrap();
        let price = price_from_bin(0, pool.bin_step).unwrap();
        assert_eq!(price, Q64x64::ONE);
        for strategy in [Strategy::Spot, Strategy::Curve, Strategy::BidAsk] {
            let (bins, value) = spread_liquidity(
                QuoteUnits(1_020_000_000),
                (-1, 1, 0),
                strategy,
                (convention, price),
            )
            .unwrap();
            let (x, y) = bins
                .iter()
                .try_fold((RawTokenAmount(0), RawTokenAmount(0)), |(x, y), bin| {
                    Ok::<_, AmountError>((x.try_add(bin.base)?, y.try_add(bin.quote)?))
                })
                .unwrap();
            let total = native_value((x, y), convention, price).unwrap();
            assert_eq!(value, QuoteUnits(i128::try_from(total.0).unwrap()));
            assert!(value.0 > 0 && value.0 <= 1_020_000_000);
            assert_eq!(bins.first().unwrap().base, RawTokenAmount(0));
            assert_eq!(bins.last().unwrap().quote, RawTokenAmount(0));
            let active = bins.iter().find(|bin| bin.bin_id == 0).unwrap();
            assert!(active.base.0 > 0 && active.quote.0 > 0);
        }
    }
}

#[test]
fn splits_native_targets_at_the_proved_bin_without_narrowing_raw_amounts() {
    for selected_x in [false, true] {
        let convention = pool(selected_x).quote_convention().unwrap();
        for raw in [
            1_020_000_000_u128,
            u128::from(u64::MAX).checked_add(1).unwrap(),
        ] {
            let target = RawTokenAmount(raw);
            let amounts = split_native(target, convention, Q64x64::ONE).unwrap();
            assert_eq!(
                native_value(amounts, convention, Q64x64::ONE).unwrap(),
                target
            );
        }
    }
}

#[test]
fn refuses_zero_prices_and_allocation_overflow_instead_of_making_a_zero() {
    let convention = pool(true).quote_convention().unwrap();
    assert!(split_native(RawTokenAmount(1), convention, Q64x64(0)).is_err());
    assert!(
        allocate_on_side(
            RawTokenAmount(u128::MAX),
            convention,
            PhysicalSide::Y,
            Q64x64(u128::MAX)
        )
        .is_err()
    );
}

#[test]
fn values_snapshot_totals_once_instead_of_summing_each_bins_floor() {
    // Both scenarios use the actual active bin1/step1000 price. Physical allocation has
    // two equal opposite-token bins, so one conversion of their raw sum gains one unit.
    for (selected_x, target, range, expected) in
        [(false, 14, (2, 3, 1), 13), (true, 4, (-1, 0, 1), 3)]
    {
        let pool = pool(selected_x);
        let convention = pool.quote_convention().unwrap();
        let price = price_from_bin(1, pool.bin_step).unwrap();
        let (bins, value) = spread_liquidity(
            QuoteUnits(target),
            range,
            Strategy::Spot,
            (convention, price),
        )
        .unwrap();
        let separate = bins
            .iter()
            .try_fold(RawTokenAmount(0), |total, bin| {
                total.try_add(native_value((bin.base, bin.quote), convention, price).unwrap())
            })
            .unwrap();
        assert_eq!(value, QuoteUnits(expected));
        assert_eq!(
            i128::try_from(separate.0).unwrap().checked_add(1).unwrap(),
            expected
        );
    }
}
