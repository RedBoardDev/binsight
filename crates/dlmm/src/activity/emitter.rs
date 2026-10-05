//! Finding the instruction that emitted an event.
//!
//! The program emits an event by calling itself from the instruction that did the work, so the
//! event sits one level deeper in the call stack than that instruction: the emitter is the
//! nearest instruction before the event, under the same top-level instruction, whose stack height
//! is one less. Transactions older than the recording of stack heights (2023, before the DLMM
//! program) have no emitter here. This module only locates; it does not read the instruction.

use binsight_solana::transaction::{InstructionNode, InstructionPosition, TransactionView};

use crate::program::PROGRAM_ID;

/// The DLMM instruction that emitted the event at `at`, if it can be told.
pub(crate) fn emitter(tx: &TransactionView, at: InstructionPosition) -> Option<&InstructionNode> {
    let index = tx
        .instructions
        .binary_search_by_key(&at, |instruction| instruction.position)
        .ok()?;
    let event_height = tx.instructions.get(index)?.stack_height?;
    let emitter_height = event_height.checked_sub(1)?;
    tx.instructions
        .get(..index)?
        .iter()
        .rev()
        .take_while(|instruction| instruction.position.top == at.top)
        .find(|instruction| instruction.stack_height == Some(emitter_height))
        .filter(|instruction| instruction.program == PROGRAM_ID)
}

/// The place of the instruction that emitted the event at `at`, if it can be told: the scope in
/// which the program reports one claim or one swap.
pub(super) fn scope_of(
    tx: &TransactionView,
    at: InstructionPosition,
) -> Option<InstructionPosition> {
    emitter(tx, at).map(|instruction| instruction.position)
}

#[cfg(test)]
mod tests {
    use binsight_solana::Address;

    use super::*;
    use crate::test_events::{event_instruction, program_instruction, transaction_with};

    fn at(top: u16, inner: Option<u16>) -> InstructionPosition {
        InstructionPosition { top, inner }
    }

    #[test]
    fn finds_the_instruction_one_level_above_the_event() {
        let caller =
            program_instruction(at(0, None), 1, vec![Address::from_bytes([7; 32])], vec![1]);
        let emitting = program_instruction(at(0, Some(0)), 2, Vec::new(), vec![2]);
        let transfer = InstructionNode {
            program: Address::from_bytes([9; 32]),
            ..program_instruction(at(0, Some(1)), 3, Vec::new(), vec![3])
        };
        let event = event_instruction(0, 2, vec![4]);
        let tx = transaction_with(vec![caller, emitting.clone(), transfer, event]);
        assert_eq!(emitter(&tx, at(0, Some(2))), Some(&emitting));
    }

    #[test]
    fn finds_no_emitter_outside_the_top_level_instruction_or_in_another_program() {
        let earlier = program_instruction(at(0, None), 2, Vec::new(), vec![1]);
        let other_program = InstructionNode {
            program: Address::from_bytes([9; 32]),
            ..program_instruction(at(1, None), 1, Vec::new(), vec![2])
        };
        let event = InstructionNode {
            stack_height: Some(2),
            ..event_instruction(1, 0, vec![3])
        };
        let tx = transaction_with(vec![earlier, other_program, event]);
        assert_eq!(emitter(&tx, at(1, Some(0))), None);
    }
}
