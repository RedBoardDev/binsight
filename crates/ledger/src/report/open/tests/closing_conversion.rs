//! UTC closing conversion changes only the derived currency quality.

use super::super::*;
use super::fixtures::{closed, pool, position, raw};

#[test]
fn converts_closes_at_their_utc_boundary_and_degrades_only_the_converted_side() {
    use crate::report::closed::ClosedValuation;
    use crate::report::valued::{Currency, resolve};
    use binsight_core::money::SolUsdRate;

    let day = jiff::civil::date(2026, 10, 5);
    let rate = SolUsdRate::new(2_000_000_000).unwrap();
    for side in [PhysicalSide::X, PhysicalSide::Y] {
        let pool = pool(side);
        let position = position(&pool);
        let closed = closed(&position);
        let mut rates = SolUsdRates {
            provisional: Some((day, rate)),
            spot: Some(SolUsdRate::new(1_000_000_000).unwrap()),
            ..SolUsdRates::default()
        };
        let open = OpenValuation::of(&position, &pool, &rates).unwrap();
        let provisional = ClosedValuation::of(&closed, &pool, &rates).unwrap();
        assert_eq!(raw(&open.pnl, Currency::Sol), 520_000_000);
        assert_eq!(raw(&provisional.pnl, Currency::Sol), 260_000_000);
        assert_eq!(raw(&provisional.pnl, Currency::Usd), 520_000_000);
        assert_eq!(
            resolve(&provisional.pnl, Currency::Usd).exactness(),
            Exactness::Complete
        );
        assert_eq!(
            resolve(&provisional.pnl, Currency::Sol).exactness(),
            Exactness::Estimated
        );
        rates.daily.insert(day, rate);
        let final_close = ClosedValuation::of(&closed, &pool, &rates).unwrap();
        assert_eq!(raw(&final_close.pnl, Currency::Usd), 520_000_000);
        assert_eq!(raw(&final_close.pnl, Currency::Sol), 260_000_000);
        assert_eq!(
            resolve(&final_close.pnl, Currency::Sol).exactness(),
            Exactness::Complete
        );
    }
}
