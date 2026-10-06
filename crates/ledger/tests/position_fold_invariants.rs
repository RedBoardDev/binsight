//! Invariants of the position fold over random synthetic lives in a SOL pool.
#[path = "common/fold.rs"]
mod common;

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::{MovementKind, PositionMovement};
use binsight_dlmm::math::price_from_bin;
use binsight_ledger::facts::{ClosedPositionFacts, SolUsdRates};
use binsight_ledger::report::closed::{ClosedValuation, Outcome, lp_pnl};
use common::*;
use proptest::prelude::*;

const KINDS: [MovementKind; 5] = [
    MovementKind::Deposit,
    MovementKind::Withdrawal,
    MovementKind::RebalanceDeposit,
    MovementKind::RebalanceWithdrawal,
    MovementKind::FeeClaim,
];

fn any_movement() -> impl Strategy<Value = PositionMovement> {
    (
        prop::sample::select(KINDS.as_slice()),
        0..1_000_000_000_000_u128,
        0..1_000_000_000_000_u128,
        -2_000..2_000_i32,
    )
        .prop_map(|(kind, x, y, bin)| movement(POSITION, SOL_POOL, kind, (x, y), Some(bin)))
}

/// The closed life of `POSITION` with one transaction per movement.
#[expect(clippy::unwrap_used, reason = "these synthetic lives close once")]
fn life(movements: &[PositionMovement]) -> ClosedPositionFacts {
    let mut steps = vec![lifecycle(vec![created(POSITION, SOL_POOL, WALLET)])];
    steps.extend(movements.iter().map(|movement| moves(vec![*movement])));
    steps.push(lifecycle(vec![closed(POSITION, WALLET)]));
    run(&mut fold(), &steps).pop().unwrap()
}

#[expect(
    clippy::unwrap_used,
    reason = "the synthetic pools include the SOL pool"
)]
fn sol_pool() -> binsight_ledger::facts::PoolFacts {
    pools().remove(&SOL_POOL).unwrap()
}

/// The value of one movement alone, in lamports.
#[expect(
    clippy::unwrap_used,
    reason = "the SOL pool has a quote and valid bins"
)]
fn value(movement: &PositionMovement) -> i128 {
    let convention = sol_pool().quote_convention().unwrap();
    let price = movement
        .price_bin
        .map(|bin| price_from_bin(bin, 100).unwrap());
    let quoted = convention.value_raw(movement.x, movement.y, price).unwrap();
    i128::try_from(quoted.amount.0).unwrap()
}

proptest! {
    #[test]
    fn the_liquidity_pnl_is_the_signed_sum_of_each_movement_valued_alone(
        movements in prop::collection::vec(any_movement(), 1..6)
    ) {
        let expected = movements.iter().fold(0_i128, |total, movement| {
            match movement.kind {
                MovementKind::Deposit | MovementKind::RebalanceDeposit => total - value(movement),
                _ => total + value(movement),
            }
        });
        prop_assert_eq!(lp_pnl(&life(&movements)).map(|pnl| pnl.0), Ok(expected));
    }

    #[test]
    fn a_rebalance_moves_invested_and_withdrawn_alike_and_never_the_pnl(
        movements in prop::collection::vec(any_movement(), 1..4),
        (x, y, bin) in (0..1_000_000_000_000_u128, 0..1_000_000_000_000_u128, -2_000..2_000_i32),
    ) {
        let without = life(&movements);
        let mut rebalanced = movements.clone();
        for kind in [MovementKind::RebalanceWithdrawal, MovementKind::RebalanceDeposit] {
            rebalanced.push(movement(POSITION, SOL_POOL, kind, (x, y), Some(bin)));
        }
        let with = life(&rebalanced);
        let half = with.invested.0 - without.invested.0;
        prop_assert_eq!(with.withdrawn.0 - without.withdrawn.0, half);
        prop_assert!(half >= 0);
        prop_assert_eq!(lp_pnl(&with), lp_pnl(&without));
    }

    #[test]
    fn an_unpriced_token_amount_always_hides_the_outcome(
        movements in prop::collection::vec(any_movement(), 0..4),
        (x, y) in (1..1_000_000_000_000_u128, 0..1_000_000_000_000_u128),
    ) {
        let mut movements = movements;
        movements.push(PositionMovement {
            x: RawTokenAmount(x),
            y: RawTokenAmount(y),
            ..movement(POSITION, SOL_POOL, MovementKind::FeeClaim, (0, 0), None)
        });
        let life = life(&movements);
        let valued = ClosedValuation::of(&life, &sol_pool(), &SolUsdRates::default());
        prop_assert_eq!(valued.map(|valued| valued.outcome), Ok(Outcome::Unknown));
    }
}
