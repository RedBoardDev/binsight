//! Rebalance halves and rewards keep their separate original source rows within the same life.
#[path = "common/lifetimes.rs"]
mod common;

use binsight_dlmm::activity::MovementKind;
use binsight_ledger::book::PositionActivitySource;
use binsight_ledger::positions::{PositionLifetimes, RawActivityEvidence};
use common::*;

#[test]
fn retains_both_rebalance_halves_and_reward_sources_at_one_instruction_without_netting() {
    let mut replay = PositionLifetimes::new(context());
    replay.apply(&opening(1, 10)).unwrap();
    let mut source = source(2, 11);
    let mut withdrawal = movement(0, 8, 13);
    withdrawal.kind = MovementKind::RebalanceWithdrawal;
    let mut deposit = withdrawal;
    deposit.kind = MovementKind::RebalanceDeposit;
    source.activity.movements.extend([withdrawal, deposit]);
    source.activity.reward_claims.push(reward(0, 5));
    let ownership = replay.apply(&source).unwrap();
    let first = ownership.position_for(PositionActivitySource::Movement {
        index: 0,
        at: at(0),
    });
    assert!(first.is_some());
    assert_eq!(
        ownership.position_for(PositionActivitySource::Movement {
            index: 1,
            at: at(0)
        }),
        first
    );
    assert_eq!(
        ownership.position_for(PositionActivitySource::RewardClaim {
            index: 0,
            at: at(0)
        }),
        first
    );
    assert_eq!(source.activity.movements, vec![withdrawal, deposit]);
    assert_eq!(
        replay.finish().lifetimes.first().unwrap().raw_activity,
        RawActivityEvidence::ObservedNonzero
    );
}
