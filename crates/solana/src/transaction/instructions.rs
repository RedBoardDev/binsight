//! Every instruction a transaction ran, top-level and inner, in execution order.
//!
//! Each top-level instruction is followed by the instructions it invoked (the node records them in
//! `meta.innerInstructions`, in call order). Accounts are resolved to addresses, so a reader never
//! needs the account list again. This module orders and resolves; decoding what an instruction
//! does is the job of [`crate::programs`].

use std::fmt;

use super::accounts::{AccountKey, address_at};
use super::error::TransactionReadError;
use super::rpc_response::{RpcCompiledInstruction, RpcInnerInstructions};
use super::wire::CompiledInstruction;
use crate::Address;

/// The stack height of a top-level instruction.
const TOP_LEVEL_STACK_HEIGHT: u8 = 1;

/// Where an instruction sits in a transaction. The order of positions is the execution order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InstructionPosition {
    /// The index of the top-level instruction (or of the one that invoked this inner one).
    pub top: u16,
    /// `None` for the top-level instruction itself, else the index among its inner instructions.
    pub inner: Option<u16>,
}

/// One instruction, with its accounts resolved to addresses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstructionNode {
    /// Where it sits.
    pub position: InstructionPosition,
    /// Its depth in the call stack (1 at top level); `None` for an inner instruction of a
    /// transaction older than the recording of stack heights.
    pub stack_height: Option<u8>,
    /// The program it calls.
    pub program: Address,
    /// The accounts it is given, in order.
    pub accounts: Vec<Address>,
    /// Its data.
    pub data: InstructionData,
}

/// The data of an instruction, shown in hexadecimal.
#[derive(Clone, PartialEq, Eq)]
pub struct InstructionData(pub Vec<u8>);

impl InstructionData {
    /// The raw bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for InstructionData {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("0x")?;
        self.0
            .iter()
            .try_for_each(|byte| write!(formatter, "{byte:02x}"))
    }
}

/// Lists every instruction in execution order: each top-level one, then its inner ones.
pub(super) fn in_execution_order(
    top_level: &[CompiledInstruction],
    inner: &[RpcInnerInstructions],
    accounts: &[AccountKey],
) -> Result<Vec<InstructionNode>, TransactionReadError> {
    if let Some(orphan) = inner
        .iter()
        .find(|group| usize::from(group.index) >= top_level.len())
    {
        return Err(TransactionReadError::InnerInstructionsWithoutParent {
            index: orphan.index,
        });
    }
    let mut nodes = Vec::new();
    for (top, instruction) in top_level.iter().enumerate() {
        let top = position_number(top)?;
        nodes.push(top_level_node(top, instruction, accounts)?);
        let invoked = inner
            .iter()
            .filter(|group| u16::from(group.index) == top)
            .flat_map(|group| &group.instructions);
        for (position, instruction) in invoked.enumerate() {
            nodes.push(inner_node(
                top,
                position_number(position)?,
                instruction,
                accounts,
            )?);
        }
    }
    Ok(nodes)
}

/// The number of the instruction at `index` in its level.
fn position_number(index: usize) -> Result<u16, TransactionReadError> {
    u16::try_from(index).map_err(|_| TransactionReadError::InstructionPositionOverflow)
}

fn top_level_node(
    top: u16,
    instruction: &CompiledInstruction,
    accounts: &[AccountKey],
) -> Result<InstructionNode, TransactionReadError> {
    Ok(InstructionNode {
        position: InstructionPosition { top, inner: None },
        stack_height: Some(TOP_LEVEL_STACK_HEIGHT),
        program: address_at(accounts, instruction.program_index)?,
        accounts: addresses_at(accounts, &instruction.account_indexes)?,
        data: InstructionData(instruction.data.clone()),
    })
}

fn inner_node(
    top: u16,
    inner: u16,
    instruction: &RpcCompiledInstruction,
    accounts: &[AccountKey],
) -> Result<InstructionNode, TransactionReadError> {
    let data = bs58::decode(&instruction.data)
        .into_vec()
        .map_err(TransactionReadError::InvalidInstructionData)?;
    Ok(InstructionNode {
        position: InstructionPosition {
            top,
            inner: Some(inner),
        },
        stack_height: instruction.stack_height,
        program: address_at(accounts, instruction.program_id_index)?,
        accounts: addresses_at(accounts, &instruction.accounts)?,
        data: InstructionData(data),
    })
}

fn addresses_at(
    accounts: &[AccountKey],
    indexes: &[u8],
) -> Result<Vec<Address>, TransactionReadError> {
    indexes
        .iter()
        .map(|&index| address_at(accounts, index))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transaction::accounts::AccountSource;

    fn account(byte: u8) -> AccountKey {
        AccountKey {
            address: Address::from_bytes([byte; 32]),
            is_signer: false,
            is_writable: false,
            source: AccountSource::Message,
        }
    }

    fn compiled(program_index: u8) -> CompiledInstruction {
        CompiledInstruction {
            program_index,
            account_indexes: vec![0],
            data: vec![program_index],
        }
    }

    fn invoked(index: u8, programs: &[u8]) -> RpcInnerInstructions {
        RpcInnerInstructions {
            index,
            instructions: programs
                .iter()
                .map(|&program_id_index| RpcCompiledInstruction {
                    program_id_index,
                    accounts: vec![0],
                    data: "2".to_owned(),
                    stack_height: Some(2),
                })
                .collect(),
        }
    }

    #[test]
    fn orders_inner_instructions_after_their_top_level_instruction() {
        let accounts = [account(0), account(1), account(2), account(3)];
        let nodes = in_execution_order(
            &[compiled(1), compiled(2)],
            &[invoked(1, &[3]), invoked(0, &[2, 3])],
            &accounts,
        )
        .unwrap();
        let order: Vec<_> = nodes
            .iter()
            .map(|node| (node.position.top, node.position.inner, node.program))
            .collect();
        assert_eq!(
            order,
            [
                (0, None, accounts[1].address),
                (0, Some(0), accounts[2].address),
                (0, Some(1), accounts[3].address),
                (1, None, accounts[2].address),
                (1, Some(0), accounts[3].address),
            ]
        );
        assert!(
            nodes
                .windows(2)
                .all(|pair| pair[0].position < pair[1].position)
        );
        assert_eq!(nodes[1].data, InstructionData(vec![1]));
    }

    #[test]
    fn refuses_inner_instructions_of_a_missing_top_level_instruction() {
        let error =
            in_execution_order(&[compiled(0)], &[invoked(3, &[0])], &[account(0)]).unwrap_err();
        assert!(matches!(
            error,
            TransactionReadError::InnerInstructionsWithoutParent { index: 3 }
        ));
    }

    #[test]
    fn refuses_an_account_index_out_of_range() {
        let error = in_execution_order(&[compiled(5)], &[], &[account(0)]).unwrap_err();
        assert!(matches!(
            error,
            TransactionReadError::AccountIndexOutOfRange {
                index: 5,
                accounts: 1
            }
        ));
    }

    #[test]
    fn refuses_more_inner_instructions_than_a_position_can_number() {
        let too_many = usize::from(u16::MAX) + 2;
        let group = RpcInnerInstructions {
            index: 0,
            instructions: (0..too_many)
                .map(|_| RpcCompiledInstruction {
                    program_id_index: 0,
                    accounts: Vec::new(),
                    data: String::new(),
                    stack_height: Some(2),
                })
                .collect(),
        };
        let error = in_execution_order(&[compiled(0)], &[group], &[account(0)]).unwrap_err();
        assert!(matches!(
            error,
            TransactionReadError::InstructionPositionOverflow
        ));
    }

    #[test]
    fn shows_instruction_data_in_hexadecimal() {
        assert_eq!(format!("{:?}", InstructionData(vec![0xe4, 0x05])), "0xe405");
    }
}
