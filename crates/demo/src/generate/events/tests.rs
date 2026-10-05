//! Every position's movements add up to its figures, and every movement is valued at its bin.

#![expect(
    clippy::arithmetic_side_effects,
    reason = "the tests add amounts far below the integer limits"
)]

use binsight_dlmm::math::{mul_shr_64, price_from_bin};
use binsight_engine::portfolio::{Scope, Snapshot};
use binsight_ledger::facts::{PositionEventFact, PositionEventKind, PositionId};
use jiff::Timestamp;
use jiff::tz::TimeZone;

use crate::scenario::DEMO_SEED;
use crate::world::{World, WorldSpec};

/// The sums of a position's deposits, withdrawals and claims.
#[derive(Debug, Default, PartialEq, Eq)]
struct Sums {
    deposited: i128,
    withdrawn: i128,
    claimed: i128,
}

fn world() -> World {
    let spec = WorldSpec {
        seed: DEMO_SEED,
        anchor: "2026-10-04T15:30:00Z".parse::<Timestamp>().unwrap(),
        timezone: TimeZone::get("Europe/Paris").unwrap(),
        importing_wallet: None,
    };
    World::generate(&spec).unwrap()
}

fn sums(events: &[PositionEventFact]) -> Sums {
    let mut sums = Sums::default();
    for event in events {
        let value = event.kind.flow().map_or(0, |flow| flow.value.0);
        match event.kind {
            PositionEventKind::Add(_) => sums.deposited += value,
            PositionEventKind::Remove(_) => {
                sums.withdrawn += value;
            }
            PositionEventKind::Claim(_) => sums.claimed += value,
            PositionEventKind::Created { .. }
            | PositionEventKind::Closed
            | PositionEventKind::RebalanceDeposit { .. }
            | PositionEventKind::RebalanceWithdrawal(_)
            | PositionEventKind::RewardClaim(_) => {}
        }
    }
    sums
}

fn assert_valued_at_their_bin(snapshot: &Snapshot, pool: binsight_solana::Address, id: PositionId) {
    let bin_step = snapshot.pool(pool).unwrap().bin_step;
    for event in snapshot.events_of(id) {
        let (Some(flow), Some(bin)) = (event.kind.flow(), event.active_bin_id) else {
            continue;
        };
        let price = price_from_bin(bin, bin_step).unwrap();
        let base_value = mul_shr_64(flow.base.0, price).unwrap();
        assert_eq!(
            i128::try_from(base_value + flow.quote.0).unwrap(),
            flow.value.0,
            "{id}"
        );
    }
}

#[test]
fn adds_the_movements_of_every_closed_position_up_to_its_figures() {
    let world = world();
    let snapshot = &world.snapshot;

    for row in snapshot.closed_in(Scope::All) {
        let events = snapshot.events_of(row.facts.id);
        let expected = Sums {
            deposited: row.facts.invested.0,
            withdrawn: row.facts.withdrawn.0,
            claimed: row.facts.claimed_fees.0,
        };

        assert_eq!(sums(events), expected, "{}", row.facts.id);
        assert!(matches!(
            events.first().unwrap().kind,
            PositionEventKind::Created { .. }
        ));
        assert!(matches!(
            events.last().unwrap().kind,
            PositionEventKind::Closed
        ));
        assert_eq!(events.first().unwrap().signature, row.facts.id.opened_by);
        assert_valued_at_their_bin(snapshot, row.facts.pool, row.facts.id);
    }
}

#[test]
fn adds_the_movements_of_every_open_position_up_to_its_figures() {
    let world = world();
    let snapshot = &world.snapshot;

    for row in snapshot.open_in(Scope::All) {
        let events = snapshot.events_of(row.facts.id);
        let expected = Sums {
            deposited: row.facts.invested.0,
            withdrawn: row.facts.withdrawn.0,
            claimed: row.facts.claimed_fees.0,
        };

        assert_eq!(sums(events), expected, "{}", row.facts.id);
        assert!(events.iter().all(|event| event.at <= row.facts.valued_at));
        assert_valued_at_their_bin(snapshot, row.facts.pool, row.facts.id);
    }
}

#[test]
fn moves_the_range_of_some_positions_and_leaves_some_movements_unpriced() {
    let world = world();
    let events: Vec<&PositionEventFact> = world
        .snapshot
        .closed_in(Scope::All)
        .flat_map(|row| world.snapshot.events_of(row.facts.id))
        .collect();

    assert!(
        events
            .iter()
            .any(|event| matches!(event.kind, PositionEventKind::RebalanceDeposit { .. }))
    );
    assert!(events.iter().any(|event| event.active_bin_id.is_none()));
}
