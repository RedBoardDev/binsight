//! A movement without a price leaves the PnL a bound, by its direction: an unpriced withdrawal or
//! fee claim only leaves value out (a lower bound), an unpriced deposit leaves a cost out. The
//! outcome keeps every sign that is certain.
#[path = "common/fold.rs"]
mod common;

use binsight_core::exactness::Exactness;
use binsight_dlmm::activity::{MovementKind, PositionMovement, TxActivity};
use binsight_ledger::facts::{QuoteUnits, UnpricedMovements};
use binsight_ledger::report::closed::{Outcome, lp_pnl};
use common::*;

fn one(kind: MovementKind, amounts: (u128, u128), bin: Option<i32>) -> TxActivity {
    moves(vec![movement(POSITION, SOL_POOL, kind, amounts, bin)])
}

fn claim_without_bin(x: u128, y: u128) -> TxActivity {
    let claim: PositionMovement =
        movement(POSITION, SOL_POOL, MovementKind::FeeClaim, (x, y), None);
    moves(vec![claim])
}

/// Oracles O-4 and O-5: a claim without a bin of 112,397,677 lamports counts exactly. Beside
/// 896,784,000 unpriced raw tokens it still counts its lamports: the PnL is at least +112,397,677,
/// a certain win, and a lower bound.
#[test]
fn counts_a_positive_lower_bound_with_an_unpriced_claim_as_a_partial_win() {
    let complete = life(SOL_POOL, vec![claim_without_bin(0, 112_397_677)]);
    assert!(complete[0].unpriced_movements.is_none());
    let valued_complete = valued(&complete[0]);
    assert_eq!(valued_complete.outcome, Outcome::Win);
    assert_eq!(valued_complete.native_pnl.exactness(), Exactness::Complete);

    let partial = life(SOL_POOL, vec![claim_without_bin(896_784_000, 112_397_677)]);
    assert_eq!(partial[0].claimed_fees, QuoteUnits(112_397_677));
    assert_eq!(
        partial[0].unpriced_movements,
        UnpricedMovements {
            fee_claims: 1,
            ..UnpricedMovements::default()
        }
    );
    assert_eq!(lp_pnl(&partial[0]), Ok(QuoteUnits(112_397_677)));
    let valued = valued(&partial[0]);
    assert_eq!(valued.outcome, Outcome::Win);
    assert_eq!(valued.native_pnl.exactness(), Exactness::Partial);
    assert_eq!(valued.claimed_fees.exactness(), Exactness::Partial);
    assert_eq!(valued.invested.exactness(), Exactness::Complete);
    assert_eq!(valued.withdrawn.exactness(), Exactness::Complete);
}

/// 1,000,000 lamports deposited, 900,000 withdrawn, and a claim of 5,000 raw tokens without a
/// bin: the known PnL is −100,000, and the unpriced tokens could turn it into a gain.
#[test]
fn hides_the_sign_of_a_negative_known_pnl_beside_an_unpriced_claim() {
    let closed = life(
        SOL_POOL,
        vec![
            one(MovementKind::Deposit, (0, 1_000_000), Some(0)),
            one(MovementKind::Withdrawal, (0, 900_000), Some(0)),
            claim_without_bin(5_000, 0),
        ],
    );
    assert_eq!(lp_pnl(&closed[0]), Ok(QuoteUnits(-100_000)));
    let valued = valued(&closed[0]);
    assert_eq!(valued.outcome, Outcome::Unknown);
    assert_eq!(valued.native_pnl.exactness(), Exactness::Partial);
}

/// A deposit of 1,000 raw tokens and 500 lamports without a bin counts its 500 lamports only: the
/// tokens are a cost left out. Withdrawing 100 lamports is a certain loss (at most −400); 2,000
/// lamports leave a sign the tokens could still reverse.
#[test]
fn keeps_only_a_certain_loss_beside_an_unpriced_deposit() {
    let deposit = || one(MovementKind::Deposit, (1_000, 500), None);
    let withdrawal = |lamports| one(MovementKind::Withdrawal, (0, lamports), Some(0));

    let loss = life(SOL_POOL, vec![deposit(), withdrawal(100)]);
    assert_eq!(loss[0].invested, QuoteUnits(500));
    assert_eq!(loss[0].unpriced_movements.deposits, 1);
    assert_eq!(lp_pnl(&loss[0]), Ok(QuoteUnits(-400)));
    let valued_loss = valued(&loss[0]);
    assert_eq!(valued_loss.outcome, Outcome::Loss);
    assert_eq!(valued_loss.native_pnl.exactness(), Exactness::Estimated);
    assert_eq!(valued_loss.invested.exactness(), Exactness::Partial);

    let unsure = life(SOL_POOL, vec![deposit(), withdrawal(2_000)]);
    assert_eq!(lp_pnl(&unsure[0]), Ok(QuoteUnits(1_500)));
    assert_eq!(valued(&unsure[0]).outcome, Outcome::Unknown);
}
