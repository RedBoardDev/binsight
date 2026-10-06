//! What a transaction did to DLMM positions, normalised from its events.
//!
//! [`position_activity`] turns the decoded events of one transaction into position facts:
//! positions created and closed, liquidity deposited and withdrawn, fees and rewards claimed, and
//! swaps that went through a pool. The rules:
//!
//! 1. A failed transaction did nothing (its fee is the ledger's business): no activity at all.
//! 2. `AddLiquidity` and `RemoveLiquidity` are a deposit and a withdrawal at their active bin.
//! 3. `Rebalancing` is a withdrawal and a deposit (each only when not zero), plus the fees and
//!    rewards it harvested, unless a claim event of the same instruction reports that same claim.
//! 4. A fee or reward claim is counted once per identity: the instruction that paid it, the pool,
//!    the position and the amounts. The program emits the first form of a claim event beside the
//!    second one, and may emit an event twice; two instructions paying equal amounts are two
//!    claims.
//! 5. A claim of the first form, which has no bin, borrows the bin of the first event of the
//!    **same pool** in the transaction, or has none.
//! 6. The mint of a claimed reward is read from the accounts of the instruction that paid it,
//!    or, for a reward a rebalance harvested, from the transfer of that reward's amount.
//! 7. A closed position account (no lamports left) must come with a `PositionClose` event, and
//!    a position account created and still funded with a `PositionCreate`: otherwise the
//!    transaction is refused rather than read with a position wrongly open or missing.
//! 8. The program reports a swap twice (`Swap` and `Swap2Evt`): it is counted once.
//! 9. An unknown event or instruction is not an error, but the activity says it saw one, so that
//!    the figures built on it can be marked partial.
//!
//! This module does not decide whose positions they are, nor what they are worth: that is the
//! ledger's job.

mod claims;
pub(crate) mod emitter;
mod facts;
mod lifecycle_guard;
mod rebalance;
mod swaps;
mod transfers;

use binsight_solana::transaction::{InstructionPosition, TransactionView, TxOutcome};

pub use facts::{
    ActivityError, LifecycleFact, MovementKind, PoolSwap, PositionMovement, RewardClaim, TxActivity,
};
pub use transfers::{TokenTransfer, emitter_transfers};

use crate::event::{DlmmEvent, LiquidityChanged, LocatedEvent};
use crate::instruction::{InstructionKind, classify};
use claims::ClaimBook;

/// Which of its two forms an event the program emits twice is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventForm {
    /// The first form (`ClaimFee`, `ClaimReward`, `Swap`).
    First,
    /// The second form (`ClaimFee2`, `ClaimReward2`, `Swap2Evt`).
    Second,
}

/// What `tx` did to DLMM positions, from its decoded `events` (see the module rules).
///
/// # Errors
///
/// Returns an [`ActivityError`] when a position account was opened or closed without the event
/// that says so: the decoding of such a transaction is a failure, retried by the next decoder
/// version, never a position silently left open or missing.
pub fn position_activity(
    tx: &TransactionView,
    events: &[LocatedEvent],
) -> Result<TxActivity, ActivityError> {
    if tx.outcome != TxOutcome::Succeeded {
        return Ok(TxActivity::default());
    }
    lifecycle_guard::check(tx, events)?;
    let mut activity = TxActivity {
        pool_swaps: swaps::pool_swaps(tx, events),
        has_unknown_program_activity: has_unknown_instruction(tx),
        ..TxActivity::default()
    };
    let mut claims = ClaimBook::new(tx, events);
    for &LocatedEvent { at, event } in events {
        record(at, event, &mut claims, &mut activity);
    }
    Ok(activity)
}

/// Adds to `activity` what the event at `at` did. Every variant is named, so a new event that
/// moves tokens cannot be ignored by accident.
fn record(
    at: InstructionPosition,
    event: DlmmEvent,
    claims: &mut ClaimBook<'_>,
    activity: &mut TxActivity,
) {
    match event {
        DlmmEvent::PositionCreate(created) => activity.lifecycle.push(LifecycleFact::Created {
            at,
            position: created.position,
            pool: created.lb_pair,
            owner: created.owner,
        }),
        DlmmEvent::PositionClose(closed) => activity.lifecycle.push(LifecycleFact::Closed {
            at,
            position: closed.position,
            owner: closed.owner,
        }),
        DlmmEvent::AddLiquidity(change) => {
            activity
                .movements
                .push(liquidity(at, change, MovementKind::Deposit));
        }
        DlmmEvent::RemoveLiquidity(change) => {
            activity
                .movements
                .push(liquidity(at, change, MovementKind::Withdrawal));
        }
        DlmmEvent::Rebalancing(rebalanced) => {
            rebalance::record(at, &rebalanced, claims, activity);
        }
        DlmmEvent::ClaimFee(claim) => claims.record_first_form_fee(at, &claim, activity),
        DlmmEvent::ClaimFee2 {
            claim,
            active_bin_id,
        } => claims.record_second_form_fee(at, &claim, active_bin_id, activity),
        DlmmEvent::ClaimReward(claim) => claims.record_first_form_reward(at, &claim, activity),
        DlmmEvent::ClaimReward2 { claim, .. } => {
            claims.record_second_form_reward(at, &claim, activity);
        }
        DlmmEvent::Unknown { .. } => activity.has_unknown_program_activity = true,
        // Swaps are counted apart, once per swap (rule 8). The composition fee is already part
        // of the amounts of its `AddLiquidity`. Limit orders and position lengths move no
        // liquidity of a position, and the unmodelled events are pool administration.
        DlmmEvent::Swap(_)
        | DlmmEvent::Swap2(_)
        | DlmmEvent::CompositionFee(_)
        | DlmmEvent::PlaceLimitOrder(_)
        | DlmmEvent::CancelLimitOrder(_)
        | DlmmEvent::CloseLimitOrder(_)
        | DlmmEvent::IncreasePositionLength(_)
        | DlmmEvent::DecreasePositionLength(_)
        | DlmmEvent::Unmodelled(_) => {}
    }
}

fn has_unknown_instruction(tx: &TransactionView) -> bool {
    tx.instructions
        .iter()
        .any(|instruction| classify(instruction) == Some(InstructionKind::Unknown))
}

fn liquidity(
    at: InstructionPosition,
    change: LiquidityChanged,
    kind: MovementKind,
) -> PositionMovement {
    PositionMovement {
        at,
        position: change.position,
        pool: change.lb_pair,
        kind,
        x: change.amount_x,
        y: change.amount_y,
        price_bin: Some(change.active_bin_id),
    }
}
