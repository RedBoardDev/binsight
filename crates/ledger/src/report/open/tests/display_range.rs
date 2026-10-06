//! Selected display axes leave original liquidity amounts and bin IDs unchanged.

use super::super::*;
use super::fixtures::{pool, position};

#[test]
fn maps_displayed_range_and_composition_without_changing_physical_bin_ids() {
    use crate::facts::BinLiquidity;
    use binsight_core::units::RawTokenAmount;
    use binsight_dlmm::math::price_from_bin;

    for side in [PhysicalSide::X, PhysicalSide::Y] {
        let pool = pool(side);
        let mut position = position(&pool);
        for (active, x_status, y_status, x, y, x_composition, y_composition) in [
            (
                3,
                RangeStatus::Below,
                RangeStatus::Above,
                0,
                1,
                Composition::AllBase,
                Composition::AllQuote,
            ),
            (
                -3,
                RangeStatus::Above,
                RangeStatus::Below,
                1,
                0,
                Composition::AllQuote,
                Composition::AllBase,
            ),
            (
                0,
                RangeStatus::InRange,
                RangeStatus::InRange,
                1,
                1,
                Composition::Mixed,
                Composition::Mixed,
            ),
        ] {
            position.active_bin_id = active;
            position.bins = vec![BinLiquidity {
                bin_id: 0,
                base: RawTokenAmount(x),
                quote: RawTokenAmount(y),
            }];
            let quote = pool.quote_convention().unwrap();
            let source_value = quote
                .value_raw(
                    RawTokenAmount(x),
                    RawTokenAmount(y),
                    Some(price_from_bin(active, pool.bin_step).unwrap()),
                )
                .unwrap();
            position.value =
                Figure::Complete(QuoteUnits(i128::try_from(source_value.amount.0).unwrap()));
            let before = position.clone();
            let valued = OpenValuation::of(&position, &pool, &SolUsdRates::default()).unwrap();
            assert_eq!(
                valued.range,
                if side == PhysicalSide::X {
                    x_status
                } else {
                    y_status
                }
            );
            assert_eq!(
                valued.composition,
                if side == PhysicalSide::X {
                    x_composition
                } else {
                    y_composition
                }
            );
            assert_eq!(position, before);
        }
    }
}
