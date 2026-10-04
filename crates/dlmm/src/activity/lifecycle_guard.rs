//! The guard against a position opened or closed without the event that says so.
//!
//! Positions are opened and closed by their events, so a missing event would leave a closed
//! position open forever, or an open one invisible. The balances tell what really happened:
//!
//! - an account a close instruction left without lamports was closed, and must have its
//!   `PositionClose`. A `close_position_if_empty` that finds the position not empty succeeds
//!   without closing anything (and without an event), which is fine;
//! - an account an `initialize_position*` instruction left with lamports was created, and must
//!   have its `PositionCreate` (unless it was closed again in the same transaction).
//!
//! When a check fails, the decoding fails, and the next decoder version retries it. This module
//! only checks.

use binsight_core::units::Lamports;
use binsight_solana::Address;
use binsight_solana::transaction::{InstructionNode, TransactionView};

use super::ActivityError;
use crate::event::{DlmmEvent, LocatedEvent};
use crate::instruction::{
    INITIALIZE_POSITION, INITIALIZE_POSITION_BY_OPERATOR, INITIALIZE_POSITION_PDA,
    INITIALIZE_POSITION2, InstructionKind, OPEN_DERIVED_POSITION_ACCOUNT, OPEN_POSITION_ACCOUNT,
    classify, instruction_name,
};

/// The position of the position account among the accounts of every close instruction.
const CLOSE_POSITION_ACCOUNT: usize = 0;

/// Checks that every position a close instruction of `tx` emptied has its `PositionClose`, and
/// that every position an open instruction left funded has its `PositionCreate`.
pub(super) fn check(tx: &TransactionView, events: &[LocatedEvent]) -> Result<(), ActivityError> {
    for instruction in &tx.instructions {
        match classify(instruction) {
            Some(InstructionKind::ClosePosition) => check_close(tx, events, instruction)?,
            Some(InstructionKind::OpenPosition) => check_open(tx, events, instruction)?,
            _ => {}
        }
    }
    Ok(())
}

fn check_close(
    tx: &TransactionView,
    events: &[LocatedEvent],
    instruction: &InstructionNode,
) -> Result<(), ActivityError> {
    let at = instruction.position;
    let position = position_account(instruction, CLOSE_POSITION_ACCOUNT)?;
    let has_event = events.iter().any(|located| {
        matches!(located.event, DlmmEvent::PositionClose(closed) if closed.position == position)
    });
    if lamports_after(tx, position) == Some(Lamports(0)) && !has_event {
        return Err(ActivityError::CloseWithoutEvent { position, at });
    }
    Ok(())
}

fn check_open(
    tx: &TransactionView,
    events: &[LocatedEvent],
    instruction: &InstructionNode,
) -> Result<(), ActivityError> {
    let at = instruction.position;
    let account = match instruction_name(instruction) {
        Some(INITIALIZE_POSITION | INITIALIZE_POSITION2) => OPEN_POSITION_ACCOUNT,
        Some(INITIALIZE_POSITION_PDA | INITIALIZE_POSITION_BY_OPERATOR) => {
            OPEN_DERIVED_POSITION_ACCOUNT
        }
        _ => return Ok(()),
    };
    let position = position_account(instruction, account)?;
    let has_event = events.iter().any(|located| {
        matches!(located.event, DlmmEvent::PositionCreate(created) if created.position == position)
    });
    let is_funded = lamports_after(tx, position).is_some_and(|lamports| lamports != Lamports(0));
    if is_funded && !has_event {
        return Err(ActivityError::OpenWithoutEvent { position, at });
    }
    Ok(())
}

fn position_account(instruction: &InstructionNode, index: usize) -> Result<Address, ActivityError> {
    instruction
        .accounts
        .get(index)
        .copied()
        .ok_or(ActivityError::MissingPositionAccount {
            at: instruction.position,
        })
}

/// The lamports `account` holds after the transaction, if the transaction lists it.
fn lamports_after(tx: &TransactionView, account: Address) -> Option<Lamports> {
    tx.native_balances
        .iter()
        .find(|balance| balance.account == account)
        .map(|balance| balance.post)
}
