//! Classifying the instructions of the DLMM program by their discriminator.
//!
//! An instruction is identified by its first 8 bytes, never by a label a node or an indexer puts
//! on the transaction. The kind says what an instruction does to a position: it is what tells a
//! withdrawal from a position (never a purchase) from a swap routed through a pool (a real trade).
//! This module classifies and reads where an instruction names its pool's tokens
//! ([`named_tokens`]) or the bin array it creates ([`bin_array_funding`]); it does not decode an
//! instruction's parameters.

mod accounts;
mod table;

use binsight_solana::transaction::{InstructionNode, InstructionPosition, TransactionView};

use crate::program::{EVENT_IX_TAG, PROGRAM_ID};
pub use accounts::{
    BinArrayFunding, NamedTokens, bin_array_funding, named_tokens, position_rent_receiver,
};
use table::INSTRUCTIONS;
pub(crate) use table::{
    CLAIM_REWARD, CLAIM_REWARD_MINT_ACCOUNT, CLAIM_REWARD2, CLAIM_REWARD2_MINT_ACCOUNT,
    INITIALIZE_POSITION, INITIALIZE_POSITION_BY_OPERATOR, INITIALIZE_POSITION_PDA,
    INITIALIZE_POSITION2, OPEN_DERIVED_POSITION_ACCOUNT, OPEN_POSITION_ACCOUNT,
    REBALANCE_RESERVE_ACCOUNTS,
};

/// What a DLMM instruction does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InstructionKind {
    /// Creates a position (`initialize_position*`).
    OpenPosition,
    /// Adds liquidity to a position (`add_liquidity*`).
    AddLiquidity,
    /// Removes liquidity from a position (`remove_liquidity*`, `remove_all_liquidity`).
    RemoveLiquidity,
    /// Pays the swap fees of a position to its owner (`claim_fee`, `claim_fee2`).
    ClaimFee,
    /// Pays a farming reward of a position to its owner (`claim_reward`, `claim_reward2`).
    ClaimReward,
    /// Closes a position (`close_position`, `close_position2`, `close_position_if_empty`).
    ClosePosition,
    /// Moves the liquidity of a position, possibly harvesting fees and rewards
    /// (`rebalance_liquidity`).
    Rebalance,
    /// Makes a position longer or shorter (`increase_position_length*`,
    /// `decrease_position_length`).
    PositionLength,
    /// Places, cancels or closes a limit order.
    LimitOrder,
    /// Swaps against a pool (`swap*`).
    Swap,
    /// Creates or closes the accounts that hold a pool's bins (`initialize_bin_array*`,
    /// `close_bin_array`).
    BinArray,
    /// Anything else the program knows, which moves no liquidity of a position: creating and
    /// configuring pools, funding rewards, operators, protocol fees, bookkeeping.
    Admin,
    /// The program logging one of its events to itself (see [`crate::event`]).
    Event,
    /// An instruction of the program this version of binsight does not know.
    Unknown,
}

/// The kind of `instruction`, or `None` when it is not an instruction of the DLMM program.
pub fn classify(instruction: &InstructionNode) -> Option<InstructionKind> {
    if instruction.program != PROGRAM_ID {
        return None;
    }
    let data = instruction.data.as_bytes();
    if data.starts_with(&EVENT_IX_TAG) {
        return Some(InstructionKind::Event);
    }
    let kind = known(data).map_or(InstructionKind::Unknown, |(_, kind)| kind);
    Some(kind)
}

/// The IDL name of `instruction` (such as `claim_fee2`), when it is a known DLMM instruction.
pub fn instruction_name(instruction: &InstructionNode) -> Option<&'static str> {
    if instruction.program != PROGRAM_ID {
        return None;
    }
    known(instruction.data.as_bytes()).map(|(name, _)| name)
}

/// The DLMM call that emitted an event at `at`, proven by its instruction stack.
pub fn event_emitter(tx: &TransactionView, at: InstructionPosition) -> Option<&InstructionNode> {
    crate::activity::emitter::emitter(tx, at)
}

/// The name and kind of the instruction whose data is `data`, if its discriminator is known.
fn known(data: &[u8]) -> Option<(&'static str, InstructionKind)> {
    let discriminator = u64::from_be_bytes(*data.first_chunk::<8>()?);
    INSTRUCTIONS.iter().find_map(|&(kind, instructions)| {
        instructions
            .iter()
            .find(|&&(_, known)| known == discriminator)
            .map(|&(name, _)| (name, kind))
    })
}

#[cfg(test)]
mod tests {
    use binsight_solana::Address;
    use binsight_solana::transaction::InstructionPosition;

    use super::*;
    use crate::test_events::program_instruction;

    fn with_data(data: Vec<u8>) -> InstructionNode {
        let top = InstructionPosition {
            top: 0,
            inner: None,
        };
        program_instruction(top, 1, Vec::new(), data)
    }

    fn discriminator_of(name: &str) -> Vec<u8> {
        let (_, discriminator) = INSTRUCTIONS
            .iter()
            .flat_map(|(_, instructions)| instructions.iter())
            .find(|(known, _)| *known == name)
            .unwrap();
        discriminator.to_be_bytes().to_vec()
    }

    #[test]
    fn classifies_an_instruction_by_its_discriminator() {
        let cases = [
            ("initialize_position_pda", InstructionKind::OpenPosition),
            ("add_liquidity_by_strategy2", InstructionKind::AddLiquidity),
            ("remove_all_liquidity", InstructionKind::RemoveLiquidity),
            ("claim_fee2", InstructionKind::ClaimFee),
            ("claim_reward2", InstructionKind::ClaimReward),
            ("close_position_if_empty", InstructionKind::ClosePosition),
            ("rebalance_liquidity", InstructionKind::Rebalance),
            ("place_limit_order", InstructionKind::LimitOrder),
            ("swap2", InstructionKind::Swap),
            ("initialize_bin_array", InstructionKind::BinArray),
            ("initialize_lb_pair2", InstructionKind::Admin),
        ];
        for (name, kind) in cases {
            let mut data = discriminator_of(name);
            data.extend_from_slice(&[0; 24]);
            let instruction = with_data(data);
            assert_eq!(classify(&instruction), Some(kind), "{name}");
            assert_eq!(instruction_name(&instruction), Some(name));
        }
    }

    #[test]
    fn classifies_an_event_call_apart_from_the_instructions() {
        let mut data = EVENT_IX_TAG.to_vec();
        data.extend_from_slice(&[0; 8]);
        assert_eq!(classify(&with_data(data)), Some(InstructionKind::Event));
    }

    #[test]
    fn calls_an_unknown_or_short_discriminator_unknown() {
        assert_eq!(
            classify(&with_data(vec![0; 8])),
            Some(InstructionKind::Unknown)
        );
        assert_eq!(
            classify(&with_data(vec![1, 2])),
            Some(InstructionKind::Unknown)
        );
        assert_eq!(instruction_name(&with_data(vec![1, 2])), None);
    }

    #[test]
    fn ignores_instructions_of_other_programs() {
        let instruction = InstructionNode {
            program: Address::from_bytes([3; 32]),
            ..with_data(discriminator_of("swap"))
        };
        assert_eq!(classify(&instruction), None);
        assert_eq!(instruction_name(&instruction), None);
    }
}
