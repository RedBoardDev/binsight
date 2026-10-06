//! A farming reward counts in its position's PnL when its price is known: at its amount in the
//! pool's quote token, at the bin of its own transaction in the pool's base token.
#[path = "common/fold.rs"]
mod common;

use binsight_core::exactness::Exactness;
use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::{MovementKind, RewardClaim, TxActivity};
use binsight_ledger::facts::QuoteUnits;
use binsight_ledger::report::closed::{Outcome, lp_pnl};
use binsight_solana::Address;
use binsight_solana::well_known::{USDT_MINT, WSOL_MINT};
use common::*;

/// A transaction paying `amount` of `mint` as a reward of `POSITION` in `pool`, beside a claim
/// of nothing at `bin` when one is given, as the program reports a claim with its bin.
fn reward(pool: Address, (mint, amount): (Address, u128), bin: Option<i32>) -> TxActivity {
    TxActivity {
        movements: bin
            .map(|bin| movement(POSITION, pool, MovementKind::FeeClaim, (0, 0), Some(bin)))
            .into_iter()
            .collect(),
        reward_claims: vec![RewardClaim {
            at: at(0),
            position: POSITION,
            pool,
            reward_index: 0,
            mint: Some(mint),
            amount: RawTokenAmount(amount),
        }],
        ..TxActivity::default()
    }
}

/// A reward of 300 lamports of wrapped SOL in a SOL pool counts at its amount; a reward in
/// another token has no price.
#[test]
fn values_a_reward_paid_in_the_quote_token_and_leaves_any_other_unpriced() {
    let closed = life(
        SOL_POOL,
        vec![
            reward(SOL_POOL, (WSOL_MINT, 300), None),
            reward(SOL_POOL, (OTHER_TOKEN, 7_000), Some(0)),
        ],
    );
    assert_eq!(closed[0].rewards, QuoteUnits(300));
    assert_eq!(closed[0].unpriced_rewards, 1);
    assert_eq!(lp_pnl(&closed[0]), Ok(QuoteUnits(300)));
    let valued = valued(&closed[0]);
    assert_eq!(valued.outcome, Outcome::Win);
    assert_eq!(valued.native_pnl.exactness(), Exactness::Partial);
    assert_eq!(valued.rewards.exactness(), Exactness::Partial);
}

/// 1,000 raw units of the pool's base token paid as a reward in a transaction whose claim sits at
/// bin 100 are worth floor(1,000 × 1.01^100) = 2,704 lamports, and the life stays complete.
#[test]
fn values_a_reward_in_the_base_token_at_the_bin_of_its_own_transaction() {
    let closed = life(SOL_POOL, vec![reward(SOL_POOL, (TOKEN, 1_000), Some(100))]);
    assert_eq!(closed[0].rewards, QuoteUnits(2_704));
    assert_eq!(closed[0].unpriced_rewards, 0);
    assert_eq!(lp_pnl(&closed[0]), Ok(QuoteUnits(2_704)));
    let valued = valued(&closed[0]);
    assert_eq!(valued.native_pnl.exactness(), Exactness::Complete);
    assert_eq!(valued.rewards.exactness(), Exactness::Complete);
    assert_eq!(valued.outcome, Outcome::Win);
}

/// In the USDC/USDT pool, USDC (X) is the quote and USDT (Y) the base: 25,343 USDT paid at bin
/// −2 (bin step 1) are worth floor(25,343 × 1.0001²) = 25,348 micro-USDC.
#[test]
fn values_a_base_token_reward_on_the_y_side_by_dividing_by_the_bin_price() {
    let closed = life(
        STABLE_POOL,
        vec![reward(STABLE_POOL, (USDT_MINT, 25_343), Some(-2))],
    );
    assert_eq!(closed[0].rewards, QuoteUnits(25_348));
    assert_eq!(closed[0].unpriced_rewards, 0);
}

/// A base-token reward in a transaction that moves nothing else of its pool has no bin to be
/// valued at: it stays unpriced and the PnL is a lower bound.
#[test]
fn leaves_a_base_token_reward_without_a_bin_in_its_transaction_unpriced() {
    let closed = life(SOL_POOL, vec![reward(SOL_POOL, (TOKEN, 1_000), None)]);
    assert_eq!(closed[0].rewards, QuoteUnits(0));
    assert_eq!(closed[0].unpriced_rewards, 1);
    assert_eq!(
        valued(&closed[0]).native_pnl.exactness(),
        Exactness::Partial
    );
}

/// A swap through the pool moves its bin between instructions: a base-token reward takes the bin
/// of the movement nearest before it (the claim at bin 100 beside it, not the earlier one at bin
/// 0, nor the later one at bin 50), or else the nearest after it. 1,000 raw units at bin 100 are
/// worth 2,704 lamports.
#[test]
fn values_a_base_token_reward_at_the_bin_of_the_movement_nearest_to_it() {
    let claim = |top, bin| {
        let mut claim = movement(
            POSITION,
            SOL_POOL,
            MovementKind::FeeClaim,
            (0, 0),
            Some(bin),
        );
        claim.at = at(top);
        claim
    };
    let paid = |movements| {
        let mut activity = reward(SOL_POOL, (TOKEN, 1_000), None);
        if let Some(reward) = activity.reward_claims.first_mut() {
            reward.at = at(2);
        }
        activity.movements = movements;
        activity
    };
    let nearest_before = life(
        SOL_POOL,
        vec![paid(vec![claim(0, 0), claim(1, 100), claim(3, 50)])],
    );
    assert_eq!(nearest_before[0].rewards, QuoteUnits(2_704));
    let only_after = life(SOL_POOL, vec![paid(vec![claim(3, 100), claim(4, 0)])]);
    assert_eq!(only_after[0].rewards, QuoteUnits(2_704));
}
