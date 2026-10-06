//! Published native position definition with separate injected-Q64 and actual-bin oracles.

use super::super::*;
use super::fixtures::{closed, pool, position, raw};

#[test]
fn pins_first_positions_definition_to_stable_native_open_and_closed_reports() {
    use crate::report::closed::ClosedValuation;
    use crate::report::valued::{Currency, resolve};
    use binsight_core::money::SolUsdRate;
    use std::collections::BTreeMap;

    // These prevalued facts pin the injected-Q64 helper oracle, not bin0's physical price.
    assert_eq!(crate::calc_version::POSITIONS, 1);
    let rate = SolUsdRate::new(1_000_000_000).unwrap();
    for side in [PhysicalSide::X, PhysicalSide::Y] {
        let pool = pool(side);
        let position = position(&pool);
        let rates = SolUsdRates {
            daily: BTreeMap::from([(jiff::civil::date(2026, 10, 5), rate)]),
            spot: Some(rate),
            provisional: None,
        };
        let open = OpenValuation::of(&position, &pool, &rates).unwrap();
        let closed_value = ClosedValuation::of(&closed(&position), &pool, &rates).unwrap();
        for figure in [&open.value, &open.pnl, &closed_value.pnl] {
            assert_eq!(raw(figure, Currency::Usd), 520_000_000);
            assert_eq!(raw(figure, Currency::Sol), 520_000_000);
            assert_eq!(
                resolve(figure, Currency::Usd).exactness(),
                Exactness::Complete
            );
        }
        let no_fx = OpenValuation::of(&position, &pool, &SolUsdRates::default()).unwrap();
        assert_eq!(raw(&no_fx.value, Currency::Usd), 520_000_000);
        assert_eq!(
            resolve(&no_fx.value, Currency::Usd).exactness(),
            Exactness::Complete
        );
        assert_eq!(
            resolve(&no_fx.value, Currency::Sol).exactness(),
            Exactness::Unavailable
        );
        let no_fx_closed =
            ClosedValuation::of(&closed(&position), &pool, &SolUsdRates::default()).unwrap();
        assert_eq!(
            resolve(&no_fx_closed.pnl, Currency::Usd).exactness(),
            Exactness::Complete
        );
        assert_eq!(raw(&no_fx_closed.pnl, Currency::Usd), 520_000_000);
    }
}

#[test]
fn values_bin_zero_twins_with_their_actual_source_price_and_one_fx_boundary() {
    use crate::report::valued::Currency;
    use binsight_core::money::SolUsdRate;
    use binsight_core::units::RawTokenAmount;
    use binsight_dlmm::math::{Q64x64, price_from_bin};

    for (side, x, y) in [
        (PhysicalSide::Y, 1_000_000_000, 20_000_000),
        (PhysicalSide::X, 20_000_000, 1_000_000_000),
    ] {
        let pool = pool(side);
        let quote = pool.quote_convention().unwrap();
        let price = price_from_bin(0, pool.bin_step).unwrap();
        assert_eq!(price, Q64x64::ONE);
        let quoted = quote
            .value_raw(RawTokenAmount(x), RawTokenAmount(y), Some(price))
            .unwrap();
        assert_eq!(quoted.amount, RawTokenAmount(1_020_000_000));
        let mut position = position(&pool);
        position.value = Figure::Complete(QuoteUnits(i128::try_from(quoted.amount.0).unwrap()));
        let rates = SolUsdRates {
            spot: Some(SolUsdRate::new(2_000_000_000).unwrap()),
            ..SolUsdRates::default()
        };
        let valued = OpenValuation::of(&position, &pool, &rates).unwrap();
        assert_eq!(raw(&valued.value, Currency::Usd), 1_020_000_000);
        assert_eq!(raw(&valued.value, Currency::Sol), 510_000_000);
        assert_eq!(
            quote.unit_price(price, pool.base.decimals, pool.quote.decimals),
            Ok(Price(1_000_000_000_000_000_000_000))
        );
    }
}

#[test]
fn keeps_sol_native_without_stables_and_unsupported_figures_unavailable() {
    use crate::facts::TokenKind;
    use crate::report::valued::{Currency, resolve};

    let mut pool = pool(PhysicalSide::X);
    pool.base.kind = TokenKind::Other;
    let position = position(&pool);
    let native_sol = OpenValuation::of(&position, &pool, &SolUsdRates::default()).unwrap();
    assert_eq!(raw(&native_sol.value, Currency::Sol), 520_000_000);
    assert_eq!(
        resolve(&native_sol.value, Currency::Sol).exactness(),
        Exactness::Complete
    );
    assert_eq!(
        resolve(&native_sol.value, Currency::Usd).exactness(),
        Exactness::Unavailable
    );
    pool.quote.kind = TokenKind::Other;
    let unsupported = OpenValuation::of(&position, &pool, &SolUsdRates::default()).unwrap();
    assert_eq!(
        unsupported.value,
        Figure::unavailable(Reason::UnsupportedQuote { pool: pool.address })
    );
    assert_eq!(unsupported.pnl.exactness(), Exactness::Unavailable);
}
