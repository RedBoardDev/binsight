//! The generated world is plausible, deterministic and consistent with the accounting identity.

use std::collections::BTreeMap;

use binsight_core::exactness::Exactness;
use binsight_engine::portfolio::Scope;
use binsight_ledger::facts::{PnlMethod, QuoteAsset};
use binsight_ledger::report::bridge::{BridgeFacts, bridge};
use binsight_ledger::report::net_worth::NetWorth;
use binsight_ledger::report::open::RangeStatus;
use binsight_ledger::report::period::{Period, Window};
use binsight_ledger::report::real_pnl::PnlTimeline;
use binsight_ledger::report::valued::Currency;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use proptest::prelude::*;

use super::*;

/// The anchor of the fixed test world.
const ANCHOR: &str = "2026-10-04T15:30:00Z";

fn world_at(seed: u64, anchor: Timestamp, zone: &str) -> World {
    let spec = WorldSpec {
        seed,
        anchor,
        timezone: TimeZone::get(zone).unwrap(),
        importing_wallet: None,
    };
    World::generate(&spec).unwrap()
}

fn default_world() -> World {
    world_at(DEMO_SEED, ANCHOR.parse().unwrap(), "Europe/Paris")
}

#[test]
fn generates_the_planned_world() {
    let world = default_world();
    let snapshot = &world.snapshot;
    let labels: Vec<&str> = snapshot
        .wallets()
        .iter()
        .map(|wallet| wallet.label.as_str())
        .collect();
    assert_eq!(labels, ["Main", "Degen", "Cold"]);

    let closed: Vec<_> = snapshot.closed_in(Scope::All).collect();
    assert!((1_650..=1_750).contains(&closed.len()), "{}", closed.len());
    let shells = closed.iter().filter(|row| row.valuation.is_shell).count();
    assert!((8..=20).contains(&shells), "{shells} shells");
    let today = Window::of_period(
        Period::Today,
        world.status.started_at,
        &world.timezone,
        None,
    )
    .unwrap();
    let closed_today: Vec<_> = closed
        .iter()
        .filter(|row| today.contains(row.facts.closed_at))
        .collect();
    assert_eq!(closed_today.len(), 8);
    let losses = closed_today
        .iter()
        .filter(|row| row.valuation.outcome == binsight_ledger::report::closed::Outcome::Loss)
        .count();
    assert!(losses >= 2, "{losses} losses today");
    assert!(
        closed
            .iter()
            .any(|row| matches!(row.facts.method, PnlMethod::Fifo { .. }))
    );
    assert!(closed.iter().any(|row| row.facts.method == PnlMethod::Pool));

    let open: Vec<_> = snapshot.open_in(Scope::All).collect();
    assert_eq!(open.len(), 8);
    let ranges: Vec<RangeStatus> = open.iter().map(|row| row.valuation.range).collect();
    assert_eq!(
        ranges
            .iter()
            .filter(|range| **range == RangeStatus::Above)
            .count(),
        1
    );
    assert_eq!(
        ranges
            .iter()
            .filter(|range| **range == RangeStatus::Below)
            .count(),
        1
    );
    let stable = open.iter().filter(|row| {
        snapshot
            .pool(row.facts.pool)
            .and_then(binsight_ledger::facts::PoolFacts::quote_asset)
            == Some(QuoteAsset::Usdc)
    });
    assert_eq!(stable.count(), 1);
}

#[test]
fn makes_the_net_worth_partial_only_where_a_token_has_no_price() {
    let world = default_world();
    for wallet in world.snapshot.wallets() {
        let scope = Scope::Wallet(wallet.facts.address);
        let open: Vec<_> = world
            .snapshot
            .open_in(scope)
            .map(|row| &row.valuation)
            .collect();
        let net_worth = NetWorth::of(
            [&wallet.holdings],
            open.iter().copied(),
            world.snapshot.rates().spot,
        )
        .unwrap();
        let expected = if wallet.label.as_str() == "Degen" {
            Exactness::Partial
        } else {
            Exactness::Complete
        };
        assert_eq!(net_worth.total.exactness(), expected, "{}", wallet.label);
    }
}

#[test]
fn reuses_one_position_address_for_two_lives() {
    let world = default_world();
    let mut lives: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for row in world.snapshot.closed_in(Scope::All) {
        lives
            .entry(row.facts.id.address)
            .or_default()
            .push(row.facts.id);
    }
    let reused: Vec<_> = lives.values().filter(|ids| ids.len() > 1).collect();
    assert_eq!(reused.len(), 1);
    let ids = reused.first().unwrap();
    assert_ne!(ids.first(), ids.get(1));
}

#[test]
fn is_the_same_world_for_the_same_spec() {
    assert_eq!(default_world(), default_world());
    let other = world_at(DEMO_SEED ^ 1, ANCHOR.parse().unwrap(), "Europe/Paris");
    assert_ne!(default_world().snapshot, other.snapshot);
}

/// The bridge of every period closes on the gain, which only holds when the net worth minus the
/// capital equals everything realized plus the open PnL, to the lamport.
fn assert_the_accounting_identity_holds(world: &World) {
    let snapshot = &world.snapshot;
    let now = world.status.started_at;
    for wallet in snapshot.wallets() {
        let scope = Scope::Wallet(wallet.facts.address);
        let histories = snapshot.histories_in(scope);
        let timeline = PnlTimeline::new(&histories, snapshot.rates());
        let open: Vec<_> = snapshot.open_in(scope).collect();
        let net_worth = NetWorth::of(
            [&wallet.holdings],
            open.iter().map(|row| &row.valuation),
            snapshot.rates().spot,
        )
        .unwrap();
        let live = timeline.live(&net_worth.total, now).unwrap();
        let closed: Vec<_> = snapshot
            .closed_in(scope)
            .map(|row| (&row.facts, &row.valuation))
            .collect();
        let open: Vec<_> = open
            .iter()
            .map(|row| (&row.facts, &row.valuation))
            .collect();
        let entries: Vec<_> = snapshot.entries_in(scope).collect();
        for period in [
            Period::Today,
            Period::SevenDays,
            Period::OneMonth,
            Period::OneYear,
            Period::All,
        ] {
            let window =
                Window::of_period(period, now, &world.timezone, timeline.first_activity()).unwrap();
            let (gain, _) = timeline.gain(&window, &live, Currency::Sol).unwrap();
            let facts = BridgeFacts {
                wallets: &histories,
                closed: &closed,
                entries: &entries,
                open: &open,
                rates: snapshot.rates(),
            };
            if let Err(error) = bridge(facts, &window, &gain) {
                panic!("{} over {period:?}: {error}", wallet.label);
            }
        }
    }
}

#[test]
fn satisfies_the_accounting_identity() {
    assert_the_accounting_identity_holds(&default_world());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(6))]

    #[test]
    fn satisfies_the_accounting_identity_for_any_seed_anchor_and_zone(
        seed: u64,
        anchor in 1_767_225_600_i64..1_830_297_600,
        zone in prop::sample::select(vec!["UTC", "Europe/Paris", "America/New_York", "Asia/Kolkata", "Pacific/Chatham"]),
    ) {
        let world = world_at(seed, Timestamp::from_second(anchor).unwrap(), zone);
        assert_the_accounting_identity_holds(&world);
    }
}
