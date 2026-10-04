//! The two token programs, SPL Token and Token-2022.
//!
//! They share the layout of token accounts and of their base instructions, so binsight handles
//! them together and only records which one owns an account or ran an instruction. This module
//! only names them.

use crate::Address;
use crate::well_known::{TOKEN_2022_PROGRAM, TOKEN_PROGRAM};

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
}
