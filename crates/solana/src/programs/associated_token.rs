//! The Associated Token Account program: creating the canonical token account of a wallet.
//!
//! The data is empty or one byte: `0` (or nothing) creates, `1` creates unless the account
//! already exists. The rent of the new account is paid by `funder`. This module only decodes;
//! `RecoverNested` is [`AssociatedTokenInstruction::Other`].

use super::InstructionDecodeError;
use super::instruction_reader::InstructionAccounts;
use crate::Address;

/// The name used in errors.
const PROGRAM: &str = "Associated Token Account";

const CREATE: u8 = 0;
const CREATE_IDEMPOTENT: u8 = 1;

/// An Associated Token Account instruction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssociatedTokenInstruction {
    /// Creates the account, failing if it exists.
    Create(AssociatedAccountCreation),
    /// Creates the account, doing nothing if it exists.
    CreateIdempotent(AssociatedAccountCreation),
    /// Another instruction.
    Other {
        /// Its discriminator.
        discriminator: u8,
    },
}

/// The accounts of a creation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AssociatedAccountCreation {
    /// Pays the rent of the new account.
    pub funder: Address,
    /// The associated token account.
    pub account: Address,
    /// The wallet that owns it.
    pub wallet: Address,
    /// Its mint.
    pub mint: Address,
}

/// Decodes an Associated Token Account instruction from its data and accounts.
pub(super) fn decode(
    data: &[u8],
    accounts: &[Address],
) -> Result<AssociatedTokenInstruction, InstructionDecodeError> {
    let discriminator = data.first().copied().unwrap_or(CREATE);
    let name = match discriminator {
        CREATE => "Create",
        CREATE_IDEMPOTENT => "CreateIdempotent",
        _ => return Ok(AssociatedTokenInstruction::Other { discriminator }),
    };
    let accounts = InstructionAccounts::new(accounts, PROGRAM, name);
    let creation = AssociatedAccountCreation {
        funder: accounts.at(0)?,
        account: accounts.at(1)?,
        wallet: accounts.at(2)?,
        mint: accounts.at(3)?,
    };
    Ok(if discriminator == CREATE {
        AssociatedTokenInstruction::Create(creation)
    } else {
        AssociatedTokenInstruction::CreateIdempotent(creation)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accounts() -> Vec<Address> {
        (1..=6)
            .map(|byte| Address::from_bytes([byte; 32]))
            .collect()
    }

    #[test]
    fn treats_empty_data_as_a_plain_create() {
        let decoded = decode(&[], &accounts()).unwrap();
        let AssociatedTokenInstruction::Create(creation) = decoded else {
            panic!("expected a create, got {decoded:?}");
        };
        assert_eq!(creation.wallet, Address::from_bytes([3; 32]));
        assert_eq!(creation.mint, Address::from_bytes([4; 32]));
    }

    #[test]
    fn tells_an_idempotent_create_apart() {
        assert!(matches!(
            decode(&[CREATE_IDEMPOTENT], &accounts()),
            Ok(AssociatedTokenInstruction::CreateIdempotent(_))
        ));
        assert_eq!(
            decode(&[2], &accounts()),
            Ok(AssociatedTokenInstruction::Other { discriminator: 2 })
        );
    }
}
