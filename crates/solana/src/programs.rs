//! Decoders for the instructions of the native and SPL programs binsight books.
//!
//! An instruction is classified by its program address and the discriminator in its data, never
//! by a label a node attached to it. [`decode`] dispatches to the decoder of the program; a
//! program it does not know gives `None`, and an instruction the program has but binsight does
//! not book gives the `Other` variant of that program. This module does not judge whether the
//! instruction succeeded: that is in the transaction's outcome.

mod associated_token;
mod compute_budget;
mod instruction_reader;
mod system;
mod token;
mod token_program;

pub use associated_token::{AssociatedAccountCreation, AssociatedTokenInstruction};
pub use compute_budget::ComputeBudgetInstruction;
pub use system::SystemInstruction;
pub use token::{CheckedTransfer, TokenInstruction};
pub use token_program::{TOKEN_2022_FIRST_INVOCATION_SLOT, TokenProgram};

use crate::error::MalformedBytes;
use crate::transaction::InstructionNode;
use crate::well_known::{ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM};

/// An instruction of a program binsight decodes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgramInstruction {
    /// The System program.
    System(SystemInstruction),
    /// SPL Token or Token-2022, which share their base instructions.
    Token {
        /// Which of the two programs.
        program: TokenProgram,
        /// The instruction.
        instruction: TokenInstruction,
    },
    /// The Associated Token Account program.
    AssociatedToken(AssociatedTokenInstruction),
    /// The Compute Budget program.
    ComputeBudget(ComputeBudgetInstruction),
}

/// An instruction whose data or accounts do not match its program's layout.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InstructionDecodeError {
    /// The data is too short for the instruction it announces.
    #[error("the data of a {program} instruction is malformed")]
    Malformed {
        /// The program.
        program: &'static str,
        /// What could not be read.
        #[source]
        source: MalformedBytes,
    },
    /// An account the instruction needs is missing.
    #[error("the {program} instruction {instruction} has no account at position {position}")]
    MissingAccount {
        /// The program.
        program: &'static str,
        /// The instruction.
        instruction: &'static str,
        /// The position of the missing account.
        position: usize,
    },
}

/// Decodes `instruction` if its program is one binsight knows.
///
/// # Errors
///
/// Returns an [`InstructionDecodeError`] when the data or the accounts do not match the layout of
/// the instruction the data announces.
pub fn decode(
    instruction: &InstructionNode,
) -> Result<Option<ProgramInstruction>, InstructionDecodeError> {
    let data = instruction.data.as_bytes();
    let accounts = instruction.accounts.as_slice();
    let decoded = match instruction.program {
        SYSTEM_PROGRAM => ProgramInstruction::System(system::decode(data, accounts)?),
        COMPUTE_BUDGET_PROGRAM => ProgramInstruction::ComputeBudget(compute_budget::decode(data)?),
        ASSOCIATED_TOKEN_PROGRAM => {
            ProgramInstruction::AssociatedToken(associated_token::decode(data, accounts)?)
        }
        program => match TokenProgram::of(program) {
            Some(program) => ProgramInstruction::Token {
                program,
                instruction: token::decode(data, accounts)?,
            },
            None => return Ok(None),
        },
    };
    Ok(Some(decoded))
}
