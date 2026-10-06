//! Each movement is valued in the quote token of its own pool, on whichever side it sits.
#[path = "common/fold.rs"]
mod common;

use binsight_core::exactness::Exactness;
use binsight_dlmm::activity::MovementKind;
use binsight_ledger::facts::QuoteUnits;
use binsight_ledger::report::closed::{Outcome, lp_pnl};
use common::*;

#[test]
fn leaves_every_movement_of_a_pool_without_a_sol_or_dollar_quote_unpriced() {
    let closed = life(
        TOKEN_POOL,
        vec![moves(vec![movement(
            POSITION,
            TOKEN_POOL,
            MovementKind::Deposit,
            (1_000, 1_000),
            Some(0),
        )])],
    );
    assert_eq!(closed[0].invested, QuoteUnits(0));
    assert_eq!(closed[0].unpriced_movements.deposits, 1);
    let valued = valued(&closed[0]);
    assert_eq!(valued.outcome, Outcome::Unknown);
    assert_eq!(valued.native_pnl.exactness(), Exactness::Unavailable);
    assert!(!valued.is_shell);
}

/// One transaction withdraws 500 lamports from a SOL pool and 700 micro-USDC from a USDC pool:
/// each life keeps its own pool and its own quote units.
#[test]
fn values_each_movement_in_the_quote_of_its_own_pool() {
    let mut fold = fold();
    let closed = run(
        &mut fold,
        &[
            lifecycle(vec![
                created(POSITION, SOL_POOL, WALLET),
                created(SECOND_POSITION, USDC_POOL, WALLET),
            ]),
            moves(vec![
                movement(
                    POSITION,
                    SOL_POOL,
                    MovementKind::Withdrawal,
                    (0, 500),
                    Some(0),
                ),
                movement(
                    SECOND_POSITION,
                    USDC_POOL,
                    MovementKind::Withdrawal,
                    (0, 700),
                    Some(0),
                ),
            ]),
            lifecycle(vec![
                closed(POSITION, WALLET),
                closed(SECOND_POSITION, WALLET),
            ]),
        ],
    );
    let withdrawn: Vec<_> = closed
        .iter()
        .map(|life| (life.pool, life.withdrawn))
        .collect();
    assert_eq!(
        withdrawn,
        [(SOL_POOL, QuoteUnits(500)), (USDC_POOL, QuoteUnits(700))]
    );
}

/// Oracle O-6, in a USDC/USDT pool with USDC in X, bin step 1, bin −2: 27,873,767 micro-USDC
/// deposited, 27,873,798 withdrawn, and a claim of 25,228 USDC plus 25,343 USDT, worth
/// floor(25,343 × 1.0001²) = 25,348 micro-USDC. The PnL is 50,607 micro-USDC.
#[test]
fn values_usdc_in_x_by_dividing_the_other_side_by_the_bin_price() {
    let flow = |kind, (x, y)| {
        moves(vec![movement(
            POSITION,
            STABLE_POOL,
            kind,
            (x, y),
            Some(-2),
        )])
    };
    let closed = life(
        STABLE_POOL,
        vec![
            flow(MovementKind::Deposit, (27_873_767, 0)),
            flow(MovementKind::Withdrawal, (27_873_798, 0)),
            flow(MovementKind::FeeClaim, (25_228, 25_343)),
        ],
    );
    assert_eq!(closed[0].invested, QuoteUnits(27_873_767));
    assert_eq!(closed[0].withdrawn, QuoteUnits(27_873_798));
    assert_eq!(closed[0].claimed_fees, QuoteUnits(25_228 + 25_348));
    assert_eq!(lp_pnl(&closed[0]), Ok(QuoteUnits(50_607)));
    assert_eq!(valued(&closed[0]).outcome, Outcome::Win);
}
