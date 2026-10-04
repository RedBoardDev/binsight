//! The two token programs, SPL Token and Token-2022.
//!
//! They share the layout of token accounts and of their base instructions, so binsight handles
//! them together and only records which one owns an account or ran an instruction. This module
//! only names them, and says which one owns a token account when an old answer does not.

use crate::Address;
use crate::well_known::{TOKEN_2022_PROGRAM, TOKEN_PROGRAM};

/// The first mainnet slot in which a Token-2022 account can exist.
///
/// Token-2022 was deployed at slot 135,997,082 (2022-06-01) and upgraded at slot 137,079,003, but
/// no transaction invoked it before slot 147,794,159 (2022-08-27), and a token account only
/// exists once the program has initialized it. Nodes record the `programId` of a token balance
/// since a slot between 140,300,000 and 140,500,000 (2022-07), before that first invocation. So
/// a token balance without a `programId` is older than this slot and belongs to SPL Token.
/// Checked against mainnet with `getSignaturesForAddress` (the program and its program data
/// account) and `getBlock`.
pub const TOKEN_2022_FIRST_INVOCATION_SLOT: u64 = 147_794_159;

/// Which token program owns a token account or runs an instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TokenProgram {
    /// SPL Token.
    Token,
    /// Token-2022.
    Token2022,
}

impl TokenProgram {
    /// The token program at `address`, if it is one.
    pub fn of(address: Address) -> Option<Self> {
        match address {
            TOKEN_PROGRAM => Some(Self::Token),
            TOKEN_2022_PROGRAM => Some(Self::Token2022),
            _ => None,
        }
    }

    /// The program that owns a token account a node reported without its `programId`, in a
    /// transaction of `slot`: SPL Token before [`TOKEN_2022_FIRST_INVOCATION_SLOT`], else `None`
    /// (a node that knows Token-2022 always reports the program).
    pub fn of_unnamed_balance(slot: u64) -> Option<Self> {
        (slot < TOKEN_2022_FIRST_INVOCATION_SLOT).then_some(Self::Token)
    }

    /// The address of the program.
    pub fn address(self) -> Address {
        match self {
            Self::Token => TOKEN_PROGRAM,
            Self::Token2022 => TOKEN_2022_PROGRAM,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_both_token_programs_and_nothing_else() {
        for program in [TokenProgram::Token, TokenProgram::Token2022] {
            assert_eq!(TokenProgram::of(program.address()), Some(program));
        }
        assert_eq!(TokenProgram::of(Address::from_bytes([0; 32])), None);
    }

    #[test]
    fn infers_spl_token_only_before_token_2022_was_first_invoked() {
        let last_slot_without = TOKEN_2022_FIRST_INVOCATION_SLOT - 1;
        assert_eq!(
            TokenProgram::of_unnamed_balance(last_slot_without),
            Some(TokenProgram::Token)
        );
        assert_eq!(
            TokenProgram::of_unnamed_balance(TOKEN_2022_FIRST_INVOCATION_SLOT),
            None
        );
    }
}
