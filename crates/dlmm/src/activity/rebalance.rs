//! A rebalance, read as a withdrawal, a deposit, and a harvest.
//!
//! `rebalance_liquidity` moves a position's liquidity in one instruction and reports it in one
//! `Rebalancing` event: what left the old bins, what went into the new ones, and the fees and
//! rewards it harvested when asked to. Meteora counts the withdrawal and the deposit both, and so
//! does binsight. The harvest is counted unless a claim event of the same instruction reports the
//! same claim (rule 3 of [`super`]). A harvesting rebalance pays the position's fees and leaves
//! none behind, so a claim of the same position by another instruction afterwards pays fees
//! earned since: a different payment, counted apart. This module only builds the movements.

use binsight_core::units::RawTokenAmount;
use binsight_solana::transaction::InstructionPosition;

use super::claims::{ClaimBook, FeeIdentity, RewardIdentity};
use super::transfers::harvested_reward_mint;
use super::{MovementKind, PositionMovement, RewardClaim, TxActivity};
use crate::event::Rebalanced;

/// Adds to `activity` the withdrawal and the deposit of `rebalance`, and what it harvested that
/// no claim event of the same instruction reports.
pub(super) fn record(
    at: InstructionPosition,
    rebalance: &Rebalanced,
    claims: &ClaimBook<'_>,
    activity: &mut TxActivity,
) {
    let movement = |kind, x, y| PositionMovement {
        at,
        position: rebalance.position,
        pool: rebalance.lb_pair,
        kind,
        x,
        y,
        price_bin: Some(rebalance.active_bin_id),
    };
    let pairs = [
        (
            MovementKind::RebalanceWithdrawal,
            rebalance.x_withdrawn_amount,
            rebalance.y_withdrawn_amount,
        ),
        (
            MovementKind::RebalanceDeposit,
            rebalance.x_added_amount,
            rebalance.y_added_amount,
        ),
    ];
    for (kind, x, y) in pairs {
        if !is_zero(x) || !is_zero(y) {
            activity.movements.push(movement(kind, x, y));
        }
    }
    let (fee_x, fee_y) = (rebalance.x_fee_amount, rebalance.y_fee_amount);
    let scope = claims.scope(at);
    let fee = FeeIdentity {
        scope,
        pool: rebalance.lb_pair,
        position: rebalance.position,
        x: fee_x,
        y: fee_y,
    };
    if (!is_zero(fee_x) || !is_zero(fee_y)) && !claims.has_fee_claim_event(fee) {
        activity
            .movements
            .push(movement(MovementKind::FeeClaim, fee_x, fee_y));
    }
    let [first, second] = rebalance.rewards;
    for (reward_index, amount) in [(0, first), (1, second)] {
        let identity = RewardIdentity {
            scope,
            pool: rebalance.lb_pair,
            position: rebalance.position,
            reward_index,
            amount,
        };
        if !is_zero(amount) && !claims.has_reward_claim_event(identity) {
            activity.reward_claims.push(RewardClaim {
                at,
                position: rebalance.position,
                pool: rebalance.lb_pair,
                reward_index,
                mint: harvested_reward_mint(claims.tx, at, amount),
                amount,
            });
        }
    }
}

fn is_zero(amount: RawTokenAmount) -> bool {
    amount == RawTokenAmount(0)
}
