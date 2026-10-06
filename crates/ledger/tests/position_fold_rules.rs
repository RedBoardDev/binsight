//! The position fold's rules on small synthetic histories, each with its expected numbers.
#[path = "common/fold.rs"]
mod common;

use binsight_core::exactness::Exactness;
use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::{MovementKind, RewardClaim, TxActivity};
use binsight_ledger::facts::QuoteUnits;
use binsight_ledger::report::closed::{Outcome, lp_pnl};
use binsight_solana::well_known::WSOL_MINT;
use common::*;

#[test]
fn closes_a_life_that_never_moved_as_a_flat_shell() {
    let closed = life(SOL_POOL, Vec::new());
    assert_eq!(closed.len(), 1);
    assert_eq!(closed[0].opened_at, time(1));
    assert_eq!(closed[0].closed_at, time(2));
    let valued = valued(&closed[0]);
    assert!(valued.is_shell);
    assert_eq!(valued.outcome, Outcome::Flat);
}

/// 1,000 raw tokens deposited at bin 0 are worth 1,000 lamports; withdrawn at bin 100 they are
/// worth floor(1,000 × 1.01^100) = 2,704.
#[test]
fn values_each_movement_at_the_bin_of_its_own_transaction() {
    let closed = life(
        SOL_POOL,
        vec![
            moves(vec![movement(
                POSITION,
                SOL_POOL,
                MovementKind::Deposit,
                (1_000, 0),
                Some(0),
            )]),
            moves(vec![movement(
                POSITION,
                SOL_POOL,
                MovementKind::Withdrawal,
                (1_000, 0),
                Some(100),
            )]),
        ],
    );
    assert_eq!(closed[0].invested, QuoteUnits(1_000));
    assert_eq!(closed[0].withdrawn, QuoteUnits(2_704));
    assert_eq!(lp_pnl(&closed[0]), Ok(QuoteUnits(1_704)));
    assert_eq!(valued(&closed[0]).outcome, Outcome::Win);
}

/// A rebalance withdraws 5,000 lamports and re-deposits them: both halves count whole, and the
/// PnL does not move.
#[test]
fn counts_both_halves_of_a_rebalance_in_invested_and_withdrawn() {
    let closed = life(
        SOL_POOL,
        vec![
            moves(vec![movement(
                POSITION,
                SOL_POOL,
                MovementKind::Deposit,
                (0, 5_000),
                Some(3),
            )]),
            moves(vec![
                movement(
                    POSITION,
                    SOL_POOL,
                    MovementKind::RebalanceWithdrawal,
                    (0, 5_000),
                    Some(3),
                ),
                movement(
                    POSITION,
                    SOL_POOL,
                    MovementKind::RebalanceDeposit,
                    (0, 5_000),
                    Some(3),
                ),
            ]),
            moves(vec![movement(
                POSITION,
                SOL_POOL,
                MovementKind::Withdrawal,
                (0, 5_000),
                Some(3),
            )]),
        ],
    );
    assert_eq!(closed[0].invested, QuoteUnits(10_000));
    assert_eq!(closed[0].withdrawn, QuoteUnits(10_000));
    assert_eq!(lp_pnl(&closed[0]), Ok(QuoteUnits(0)));
    let valued = valued(&closed[0]);
    assert_eq!(valued.outcome, Outcome::Flat);
    assert!(!valued.is_shell);
}

/// Oracles O-4 and O-5: a claim without a bin of 112,397,677 lamports counts exactly; beside
/// 896,784,000 unpriced raw tokens it still counts its lamports, and the life is estimated.
#[test]
fn counts_a_claim_without_a_bin_on_its_quote_side_and_marks_the_sign_unknown() {
    let claim = |x| {
        moves(vec![movement(
            POSITION,
            SOL_POOL,
            MovementKind::FeeClaim,
            (x, 112_397_677),
            None,
        )])
    };
    let complete = life(SOL_POOL, vec![claim(0)]);
    assert_eq!(complete[0].claimed_fees, QuoteUnits(112_397_677));
    assert_eq!(complete[0].unpriced_movements, 0);
    assert_eq!(valued(&complete[0]).outcome, Outcome::Win);

    let partial = life(SOL_POOL, vec![claim(896_784_000)]);
    assert_eq!(partial[0].claimed_fees, QuoteUnits(112_397_677));
    assert_eq!(partial[0].unpriced_movements, 1);
    let valued = valued(&partial[0]);
    assert_eq!(valued.outcome, Outcome::Unknown);
    assert_eq!(valued.native_pnl.exactness(), Exactness::Estimated);
    assert_eq!(valued.claimed_fees.exactness(), Exactness::Partial);
}

/// A reward of 300 lamports of wrapped SOL in a SOL pool counts at its amount; a reward in
/// another token has no price.
#[test]
fn values_a_reward_paid_in_the_quote_token_and_leaves_any_other_unpriced() {
    let reward = |mint, amount| TxActivity {
        reward_claims: vec![RewardClaim {
            at: at(0),
            position: POSITION,
            pool: SOL_POOL,
            reward_index: 0,
            mint: Some(mint),
            amount: RawTokenAmount(amount),
        }],
        ..TxActivity::default()
    };
    let closed = life(
        SOL_POOL,
        vec![reward(WSOL_MINT, 300), reward(OTHER_TOKEN, 7_000)],
    );
    assert_eq!(closed[0].rewards, QuoteUnits(300));
    assert_eq!(closed[0].unpriced_rewards, 1);
    assert_eq!(lp_pnl(&closed[0]), Ok(QuoteUnits(300)));
    let valued = valued(&closed[0]);
    assert_eq!(valued.outcome, Outcome::Win);
    assert_eq!(valued.native_pnl.exactness(), Exactness::Partial);
    assert_eq!(valued.rewards.exactness(), Exactness::Partial);
}

/// An open life that invested 5,000 lamports and claimed 30, valued live at 5,100 with 20 of
/// fees to claim: its open PnL is 30 + 5,100 + 20 − 5,000 = 150.
#[test]
fn turns_an_open_life_and_its_live_valuation_into_open_facts() {
    use binsight_ledger::positions::LiveValuation;
    use binsight_ledger::report::figure::Figure;
    use binsight_ledger::report::open::open_pnl;
    let mut fold = fold();
    run(
        &mut fold,
        &[
            lifecycle(vec![created(POSITION, SOL_POOL, WALLET)]),
            moves(vec![movement(
                POSITION,
                SOL_POOL,
                MovementKind::Deposit,
                (0, 5_000),
                Some(0),
            )]),
            moves(vec![movement(
                POSITION,
                SOL_POOL,
                MovementKind::FeeClaim,
                (0, 30),
                Some(0),
            )]),
        ],
    );
    let live = LiveValuation {
        value: Figure::Complete(QuoteUnits(5_100)),
        unclaimed_fees: Figure::Complete(QuoteUnits(20)),
        unclaimed_fee_presence: Some(true),
        lower_bin_id: -2,
        upper_bin_id: 2,
        active_bin_id: 0,
        bins: Vec::new(),
        range_since: None,
        valued_at: time(10),
    };
    let facts = fold.open().next().unwrap().open_facts(WALLET, live);
    assert_eq!(facts.opened_at, time(1));
    assert_eq!(facts.invested, QuoteUnits(5_000));
    assert_eq!(facts.claimed_fees, QuoteUnits(30));
    assert_eq!(open_pnl(&facts), Ok(Figure::Complete(QuoteUnits(150))));
}
