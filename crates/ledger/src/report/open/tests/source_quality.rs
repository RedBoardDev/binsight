//! Independent snapshot sources propagate through checked native accounting before FX.

use super::super::*;
use super::fixtures::{pool, position, raw};

#[test]
fn keeps_snapshot_value_and_fees_quality_independent_in_native_pnl() {
    use crate::report::valued::{Currency, resolve};

    let pool = pool(PhysicalSide::X);
    let mut position = position(&pool);
    position.invested = QuoteUnits(150);
    position.claimed_fees = QuoteUnits(30);
    let reasons = Reasons::from([Reason::UnpricedLeg {
        position: position.id,
    }]);
    for (value_partial, fees_partial) in [(true, false), (false, true)] {
        position.value = Figure::from_parts(
            QuoteUnits(500),
            if value_partial {
                Exactness::Partial
            } else {
                Exactness::Complete
            },
            reasons.clone(),
        );
        position.unclaimed_fees = Figure::from_parts(
            QuoteUnits(20),
            if fees_partial {
                Exactness::Partial
            } else {
                Exactness::Complete
            },
            reasons.clone(),
        );
        position.unclaimed_fee_presence = if fees_partial { None } else { Some(true) };
        let valuation = OpenValuation::of(&position, &pool, &SolUsdRates::default()).unwrap();
        assert_eq!(valuation.value.exactness(), position.value.exactness());
        assert_eq!(
            valuation.unclaimed_fees.exactness(),
            position.unclaimed_fees.exactness()
        );
        assert_eq!(
            valuation.fees.exactness(),
            position.unclaimed_fees.exactness()
        );
        assert_eq!(raw(&valuation.fees, Currency::Usd), 50);
        assert_eq!(
            open_pnl(&position).unwrap(),
            Figure::Partial {
                value: QuoteUnits(400),
                reasons: reasons.clone()
            }
        );
        assert_eq!(raw(&valuation.pnl, Currency::Usd), 400);
        assert_eq!(
            resolve(&valuation.pnl, Currency::Usd).exactness(),
            Exactness::Partial
        );
    }
}

#[test]
fn preserves_unavailable_sources_without_zero_or_cross_leaf_degradation() {
    let pool = pool(PhysicalSide::X);
    for value_unavailable in [true, false] {
        let mut position = position(&pool);
        let missing = Figure::unavailable(Reason::UnpricedLeg {
            position: position.id,
        });
        if value_unavailable {
            position.value = missing.clone();
        } else {
            position.unclaimed_fees = missing.clone();
            position.unclaimed_fee_presence = None;
        }
        let valuation = OpenValuation::of(&position, &pool, &SolUsdRates::default()).unwrap();
        assert_eq!(open_pnl(&position).unwrap(), missing);
        assert!(valuation.pnl.value().is_none());
        assert_eq!(valuation.pnl.reasons(), missing.reasons());
        assert_eq!(valuation.value.exactness(), position.value.exactness());
        assert_eq!(
            valuation.unclaimed_fees.exactness(),
            position.unclaimed_fees.exactness()
        );
    }
}

#[test]
fn marks_unknown_historical_cost_or_reward_in_the_native_helper_itself() {
    let pool = pool(PhysicalSide::Y);
    for source in 0..3 {
        let mut position = position(&pool);
        position.invested = QuoteUnits(600_000_000);
        match source {
            0 => position.unpriced_movements = 1,
            1 => position.unpriced_rebalances = 1,
            _ => position.unpriced_rewards = 1,
        }
        let valuation = OpenValuation::of(&position, &pool, &SolUsdRates::default()).unwrap();
        assert_eq!(valuation.value.exactness(), Exactness::Complete);
        assert_eq!(valuation.unclaimed_fees.exactness(), Exactness::Complete);
        let pnl = open_pnl(&position).unwrap();
        assert_eq!(pnl.value(), Some(&QuoteUnits(-80_000_000)));
        assert_eq!(pnl.exactness(), Exactness::Estimated);
        assert_eq!(
            pnl.reasons(),
            Reasons::from([Reason::UnpricedLeg {
                position: position.id
            }])
        );
    }
}

#[test]
fn rounds_native_total_fees_and_pnl_once_instead_of_summing_converted_leaves() {
    use crate::report::valued::Currency;
    use binsight_core::money::SolUsdRate;

    let pool = pool(PhysicalSide::X);
    let mut position = position(&pool);
    position.value = Figure::Complete(QuoteUnits(0));
    position.claimed_fees = QuoteUnits(1);
    position.unclaimed_fees = Figure::Complete(QuoteUnits(1));
    position.unclaimed_fee_presence = Some(true);
    let rates = SolUsdRates {
        spot: Some(SolUsdRate::new(3_000_000).unwrap()),
        ..SolUsdRates::default()
    };
    let valuation = OpenValuation::of(&position, &pool, &rates).unwrap();
    assert_eq!(raw(&valuation.claimed_fees, Currency::Sol), 333);
    assert_eq!(raw(&valuation.unclaimed_fees, Currency::Sol), 333);
    assert_eq!(raw(&valuation.fees, Currency::Sol), 667);
    assert_eq!(raw(&valuation.pnl, Currency::Sol), 667);
}

#[test]
fn rejects_native_overflow_but_does_not_read_an_unavailable_operand_as_zero() {
    let pool = pool(PhysicalSide::X);
    let mut position = position(&pool);
    position.value = Figure::Complete(QuoteUnits(i128::MAX));
    position.unclaimed_fees = Figure::Complete(QuoteUnits(1));
    position.unclaimed_fee_presence = Some(true);
    assert_eq!(open_pnl(&position), Err(AmountError::Overflow));
    position.value = Figure::unavailable(Reason::UnpricedLeg {
        position: position.id,
    });
    assert_eq!(
        open_pnl(&position).unwrap().exactness(),
        Exactness::Unavailable
    );
}
