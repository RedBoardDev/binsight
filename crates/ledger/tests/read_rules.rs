//! The read rules agree with each other on random wallets: the bridge closes on the gain, the
//! series end on the headline figures, and the buckets of the positions series add up.

#![allow(
    clippy::unwrap_used,
    clippy::arithmetic_side_effects,
    reason = "tests fail loudly and sum small integers"
)]

#[path = "read_rules/bridge_cutoff.rs"]
mod bridge_cutoff;
mod common;
#[path = "read_rules/outcome.rs"]
mod outcome;

use binsight_core::exactness::Exactness;
use binsight_ledger::report::bridge::{BridgeFacts, BridgeLegKind, bridge};
use binsight_ledger::report::closed::ClosedValuation;
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::net_worth::NetWorth;
use binsight_ledger::report::open::OpenValuation;
use binsight_ledger::report::period::{Bucket, Period, Window, buckets};
use binsight_ledger::report::real_pnl::{PnlTimeline, WalletHistory, WalletHistoryFacts};
use binsight_ledger::report::series::{SeriesKind, SeriesRequest, series};
use binsight_ledger::report::valued::{Currency, resolve, sum_valued};
use common::{WalletWorld, wallet_world};
use jiff::tz::TimeZone;
use proptest::prelude::*;

const PERIODS: [Period; 6] = [
    Period::Today,
    Period::SevenDays,
    Period::OneMonth,
    Period::ThreeMonths,
    Period::OneYear,
    Period::All,
];

/// The valuations and the history of a wallet world.
struct Valued {
    closed: Vec<ClosedValuation>,
    open: Vec<OpenValuation>,
    history: WalletHistory,
    net_worth: NetWorth,
}

fn value(world: &WalletWorld) -> Valued {
    let closed: Vec<ClosedValuation> = world
        .closed
        .iter()
        .map(|position| ClosedValuation::of(position, &world.pool, &world.rates).unwrap())
        .collect();
    let open: Vec<OpenValuation> = world
        .open
        .iter()
        .map(|position| OpenValuation::of(position, &world.pool, &world.rates).unwrap())
        .collect();
    let pairs: Vec<_> = world.closed.iter().zip(&closed).collect();
    let entries: Vec<_> = world.entries.iter().collect();
    let open_facts: Vec<_> = world.open.iter().collect();
    let history = WalletHistory::new(WalletHistoryFacts {
        wallet: &world.wallet,
        closed: &pairs,
        open: &open_facts,
        entries: &entries,
        marks: &world.marks,
        rates: &world.rates,
    })
    .unwrap();
    let net_worth = NetWorth::of([&world.holdings], &open, world.rates.spot).unwrap();
    Valued {
        closed,
        open,
        history,
        net_worth,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    #[test]
    fn the_bridge_closes_on_the_gain_in_both_currencies(
        seed: u64,
        period in prop::sample::select(PERIODS.to_vec()),
    ) {
        let world = wallet_world(seed);
        let valued = value(&world);
        let wallets = [&valued.history];
        let timeline = PnlTimeline::new(&wallets, &world.rates);
        let live = timeline.live(&valued.net_worth.total, world.now).unwrap();
        let window =
            Window::of_period(period, world.now, &TimeZone::UTC, timeline.first_activity()).unwrap();
        let (gain, _) = timeline.gain(&window, &live, Currency::Sol).unwrap();

        let closed: Vec<_> = world.closed.iter().zip(&valued.closed).collect();
        let open: Vec<_> = world.open.iter().zip(&valued.open).collect();
        let entries: Vec<_> = world.entries.iter().collect();
        let facts = BridgeFacts {
            wallets: &wallets,
            closed: &closed,
            entries: &entries,
            open: &open,
            rates: &world.rates,
        };
        let bridge = bridge(facts, &window, &gain).unwrap();

        let legs = sum_valued(bridge.legs.iter().map(|leg| leg.amount.clone())).unwrap();
        prop_assert_eq!(legs.value().map(|sum| sum.sol), gain.value().map(|gain| gain.sol));
        prop_assert_eq!(legs.value().map(|sum| sum.usd), gain.value().map(|gain| gain.usd));
        let revaluation = bridge.legs.last().unwrap();
        prop_assert_eq!(revaluation.kind, BridgeLegKind::SolUsdRevaluation);
        prop_assert_eq!(revaluation.amount.value().unwrap().sol.unwrap().0, 0);
        for leg in &bridge.legs {
            if !leg.components.is_empty() {
                let parts =
                    sum_valued(leg.components.iter().map(|part| part.amount.clone())).unwrap();
                prop_assert_eq!(parts.value(), leg.amount.value());
            }
        }
    }

    #[test]
    fn the_series_end_on_the_headline_figures(
        seed: u64,
        period in prop::sample::select(PERIODS.to_vec()),
        bucket in prop::sample::select(vec![Bucket::Day, Bucket::Week, Bucket::Month]),
        currency in prop::sample::select(vec![Currency::Sol, Currency::Usd]),
    ) {
        let world = wallet_world(seed);
        let valued = value(&world);
        let wallets = [&valued.history];
        let timeline = PnlTimeline::new(&wallets, &world.rates);
        let live = timeline.live(&valued.net_worth.total, world.now).unwrap();
        let window =
            Window::of_period(period, world.now, &TimeZone::UTC, timeline.first_activity()).unwrap();
        let spans = buckets(&window, bucket, &TimeZone::UTC).unwrap();
        let request = |kind| SeriesRequest { kind, window: &window, buckets: &spans, currency };
        let (gain, gain_percent) = timeline.gain(&window, &live, currency).unwrap();

        let real_pnl = series(&timeline, &live, request(SeriesKind::RealPnl)).unwrap();
        let last = real_pnl.points.last().unwrap();
        prop_assert_eq!(&real_pnl.header.value, &gain);
        prop_assert_eq!(&last.line, &gain);
        prop_assert_eq!(last.line_share_of_net_worth.as_ref(), Some(&gain_percent));

        let positions = series(&timeline, &live, request(SeriesKind::Positions)).unwrap();
        let bars = sum_valued(positions.points.iter().map(|point| point.bar.clone().unwrap()));
        prop_assert_eq!(bars.unwrap(), positions.header.value.clone());

        let net_worth = series(&timeline, &live, request(SeriesKind::NetWorth)).unwrap();
        prop_assert_eq!(&net_worth.points.last().unwrap().line, &valued.net_worth.total);
        let shown = resolve(&net_worth.header.value, currency);
        prop_assert_ne!(shown.exactness(), Exactness::Unavailable);
    }
}

#[test]
fn keeps_live_pnl_complete_but_period_gain_estimated_when_past_cost_is_unpriced() {
    let mut world = wallet_world(7);
    world.wallet.added_at = jiff::Timestamp::UNIX_EPOCH;
    for position in &mut world.closed {
        position.unpriced_movements = 1;
    }
    let valued = value(&world);
    let wallets = [&valued.history];
    let timeline = PnlTimeline::new(&wallets, &world.rates);
    let live = timeline.live(&valued.net_worth.total, world.now).unwrap();
    let window = Window::of_period(Period::OneMonth, world.now, &TimeZone::UTC, None).unwrap();

    let (gain, _) = timeline.gain(&window, &live, Currency::Sol).unwrap();

    assert_eq!(live.real_pnl.exactness(), Exactness::Complete);
    assert_eq!(gain.exactness(), Exactness::Estimated);
    assert_eq!(valued.closed[0].pnl.exactness(), Exactness::Estimated);
}

#[test]
fn does_not_call_a_closed_pnl_or_its_history_a_lower_bound_when_cost_is_unpriced() {
    use binsight_core::money::SignedLamports;
    use binsight_ledger::facts::{OpenPnlMark, PnlMethod, QuoteUnits};

    let mut world = wallet_world(7);
    world.closed.truncate(1);
    world.open.clear();
    world.entries.clear();
    world.wallet.added_at = jiff::Timestamp::UNIX_EPOCH;
    let position = &mut world.closed[0];
    position.invested = QuoteUnits(20);
    position.withdrawn = QuoteUnits(100);
    position.claimed_fees = QuoteUnits(0);
    position.method = PnlMethod::Pool;
    position.unpriced_movements = 1;
    let closed_at = position.closed_at;
    let known = ClosedValuation::of(position, &world.pool, &world.rates).unwrap();
    assert_eq!(known.pnl.value().unwrap().sol, Some(SignedLamports(80)));
    assert_eq!(known.lp_pnl.exactness(), Exactness::Estimated);
    assert_eq!(known.pnl.exactness(), Exactness::Estimated);
    assert_eq!(known.invested.exactness(), Exactness::Partial);
    position.invested = QuoteUnits(200);
    position.unpriced_movements = 0;
    let actual = ClosedValuation::of(position, &world.pool, &world.rates).unwrap();
    assert_eq!(actual.pnl.value().unwrap().sol, Some(SignedLamports(-100)));
    position.invested = QuoteUnits(20);
    position.unpriced_movements = 1;
    world.marks = vec![OpenPnlMark {
        wallet: world.wallet.address,
        at: closed_at,
        open_pnl: Figure::Complete(SignedLamports::ZERO),
    }];
    let valued = value(&world);
    let point = valued.history.point_at(closed_at, &world.rates).unwrap();
    assert_eq!(
        point.real_pnl.value().unwrap().sol,
        Some(SignedLamports(80))
    );
    assert_eq!(point.real_pnl.exactness(), Exactness::Estimated);
    assert!(!point.real_pnl.reasons().is_empty());
}

#[test]
fn adds_valued_rewards_to_position_pnl_without_turning_them_into_fees() {
    use binsight_core::money::SignedLamports;
    use binsight_ledger::facts::{PnlMethod, QuoteUnits};
    let mut world = wallet_world(9);
    let position = &mut world.closed[0];
    position.invested = QuoteUnits(100);
    position.withdrawn = QuoteUnits(90);
    position.claimed_fees = QuoteUnits(2);
    position.rewards = QuoteUnits(12);
    position.method = PnlMethod::Pool;
    let valued = ClosedValuation::of(position, &world.pool, &world.rates).unwrap();
    assert_eq!(valued.pnl.value().unwrap().sol, Some(SignedLamports(4)));
    assert_eq!(
        valued.claimed_fees.value().unwrap().sol,
        Some(SignedLamports(2))
    );
    assert_eq!(
        valued.rewards.value().unwrap().sol,
        Some(SignedLamports(12))
    );
}

#[test]
fn does_not_blur_known_rewards_or_current_balances_with_an_unpriced_rebalance() {
    use binsight_core::money::SignedLamports;
    use binsight_ledger::facts::{PnlMethod, QuoteUnits};
    let mut world = wallet_world(9);
    let closed = &mut world.closed[0];
    closed.invested = QuoteUnits(4);
    closed.withdrawn = QuoteUnits(0);
    closed.claimed_fees = QuoteUnits(0);
    closed.rewards = QuoteUnits(12);
    closed.method = PnlMethod::Pool;
    closed.unpriced_movements = 2;
    closed.unpriced_rebalances = 1;
    let valued = ClosedValuation::of(closed, &world.pool, &world.rates).unwrap();
    assert_eq!(valued.invested.exactness(), Exactness::Estimated);
    assert_eq!(valued.withdrawn.exactness(), Exactness::Estimated);
    assert_eq!(valued.rewards.exactness(), Exactness::Complete);
    assert_eq!(
        valued.rewards.value().unwrap().sol,
        Some(SignedLamports(12))
    );
    let open = &mut world.open[0];
    open.unpriced_movements = 2;
    open.unpriced_rebalances = 1;
    open.rewards = QuoteUnits(12);
    let valued = OpenValuation::of(open, &world.pool, &world.rates).unwrap();
    assert_eq!(valued.invested.exactness(), Exactness::Estimated);
    assert_eq!(valued.withdrawn.exactness(), Exactness::Estimated);
    assert_eq!(valued.net_invested.exactness(), Exactness::Estimated);
    assert_eq!(valued.pnl.exactness(), Exactness::Estimated);
    assert_eq!(valued.value.exactness(), Exactness::Complete);
    assert_eq!(valued.unclaimed_fees.exactness(), Exactness::Complete);
    assert_eq!(valued.rewards.exactness(), Exactness::Complete);
}
