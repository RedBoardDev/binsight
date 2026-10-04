//! The System program's instructions that move lamports or create accounts.
//!
//! The data is bincode: a `u32` little-endian discriminator, then the fields; a string is a `u64`
//! length then its bytes. Like the program, the decoder ignores bytes after the fields. Only the
//! instructions binsight books are decoded; the others are [`SystemInstruction::Other`].

use binsight_core::units::Lamports;

use super::InstructionDecodeError;
use super::instruction_reader::{InstructionAccounts, InstructionFields};
use crate::Address;

/// The name used in errors.
const PROGRAM: &str = "System";

const CREATE_ACCOUNT: u32 = 0;
const ASSIGN: u32 = 1;
const TRANSFER: u32 = 2;
const CREATE_ACCOUNT_WITH_SEED: u32 = 3;
const ALLOCATE: u32 = 8;
const TRANSFER_WITH_SEED: u32 = 11;

/// A System program instruction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SystemInstruction {
    /// Creates `account`, funded by `funder`, and gives it to `owner`.
    CreateAccount {
        /// Pays the lamports.
        funder: Address,
        /// The new account.
        account: Address,
        /// The lamports moved to the new account.
        lamports: Lamports,
        /// Its data size, in bytes.
        space: u64,
        /// The program that owns it.
        owner: Address,
    },
    /// Like `CreateAccount`, at an address derived from a base and a seed.
    CreateAccountWithSeed {
        /// Pays the lamports.
        funder: Address,
        /// The new account.
        account: Address,
        /// The lamports moved to the new account.
        lamports: Lamports,
        /// Its data size, in bytes.
        space: u64,
        /// The program that owns it.
        owner: Address,
    },
    /// Gives `account` to the program `owner`.
    Assign {
        /// The account.
        account: Address,
        /// Its new owner program.
        owner: Address,
    },
    /// Allocates data for `account`.
    Allocate {
        /// The account.
        account: Address,
        /// Its data size, in bytes.
        space: u64,
    },
    /// Moves lamports from `from` to `to`.
    Transfer {
        /// Pays.
        from: Address,
        /// Receives.
        to: Address,
        /// The amount.
        lamports: Lamports,
    },
    /// Moves lamports from an account at a derived address.
    TransferWithSeed {
        /// Pays (the derived account).
        from: Address,
        /// Receives.
        to: Address,
        /// The amount.
        lamports: Lamports,
    },
    /// Another System instruction (nonce, or a `*WithSeed` variant binsight does not book).
    Other {
        /// Its discriminator.
        discriminator: u32,
    },
}

/// Decodes a System instruction from its data and accounts.
pub(super) fn decode(
    data: &[u8],
    accounts: &[Address],
) -> Result<SystemInstruction, InstructionDecodeError> {
    let mut fields = InstructionFields::new(data, PROGRAM);
    let discriminator = fields.u32("the instruction")?;
    let accounts = InstructionAccounts::new(accounts, PROGRAM, instruction_name(discriminator));
    match discriminator {
        CREATE_ACCOUNT => {
            let creation = read_creation(&mut fields)?;
            Ok(SystemInstruction::CreateAccount {
                funder: accounts.at(0)?,
                account: accounts.at(1)?,
                lamports: creation.lamports,
                space: creation.space,
                owner: creation.owner,
            })
        }
        CREATE_ACCOUNT_WITH_SEED => {
            fields.address("the base")?;
            fields.skip_string("the seed")?;
            let creation = read_creation(&mut fields)?;
            Ok(SystemInstruction::CreateAccountWithSeed {
                funder: accounts.at(0)?,
                account: accounts.at(1)?,
                lamports: creation.lamports,
                space: creation.space,
                owner: creation.owner,
            })
        }
        ASSIGN => Ok(SystemInstruction::Assign {
            account: accounts.at(0)?,
            owner: fields.address("the owner")?,
        }),
        ALLOCATE => Ok(SystemInstruction::Allocate {
            account: accounts.at(0)?,
            space: fields.u64("the space")?,
        }),
        TRANSFER => Ok(SystemInstruction::Transfer {
            from: accounts.at(0)?,
            to: accounts.at(1)?,
            lamports: Lamports(fields.u64("the lamports")?),
        }),
        TRANSFER_WITH_SEED => Ok(SystemInstruction::TransferWithSeed {
            from: accounts.at(0)?,
            to: accounts.at(2)?,
            lamports: Lamports(fields.u64("the lamports")?),
        }),
        discriminator => Ok(SystemInstruction::Other { discriminator }),
    }
}

/// The name of an instruction, for errors.
fn instruction_name(discriminator: u32) -> &'static str {
    match discriminator {
        CREATE_ACCOUNT => "CreateAccount",
        CREATE_ACCOUNT_WITH_SEED => "CreateAccountWithSeed",
        ASSIGN => "Assign",
        ALLOCATE => "Allocate",
        TRANSFER => "Transfer",
        TRANSFER_WITH_SEED => "TransferWithSeed",
        _ => "Other",
    }
}

/// The fields every account creation ends with.
struct Creation {
    lamports: Lamports,
    space: u64,
    owner: Address,
}

fn read_creation(fields: &mut InstructionFields<'_>) -> Result<Creation, InstructionDecodeError> {
    Ok(Creation {
        lamports: Lamports(fields.u64("the lamports")?),
        space: fields.u64("the space")?,
        owner: fields.address("the owner")?,
    })
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn address(byte: u8) -> Address {
        Address::from_bytes([byte; 32])
    }

    #[test]
    fn decodes_a_create_account_with_seed_after_its_seed() {
        let mut data = CREATE_ACCOUNT_WITH_SEED.to_le_bytes().to_vec();
        data.extend([3; 32]);
        data.extend(4_u64.to_le_bytes());
        data.extend(b"seed");
        data.extend(2_039_280_u64.to_le_bytes());
        data.extend(165_u64.to_le_bytes());
        data.extend([5; 32]);
        let decoded = decode(&data, &[address(1), address(2), address(3)]).unwrap();
        assert_eq!(
            decoded,
            SystemInstruction::CreateAccountWithSeed {
                funder: address(1),
                account: address(2),
                lamports: Lamports(2_039_280),
                space: 165,
                owner: address(5),
            }
        );
    }

    #[test]
    fn reports_a_missing_account_by_its_position() {
        let mut data = TRANSFER.to_le_bytes().to_vec();
        data.extend(1_u64.to_le_bytes());
        assert_eq!(
            decode(&data, &[address(1)]),
            Err(InstructionDecodeError::MissingAccount {
                program: PROGRAM,
                instruction: "Transfer",
                position: 1
            })
        );
    }

    #[test]
    fn keeps_an_instruction_it_does_not_book_as_other() {
        let data = 4_u32.to_le_bytes();
        assert_eq!(
            decode(&data, &[]),
            Ok(SystemInstruction::Other { discriminator: 4 })
        );
    }

    proptest! {
        #[test]
        fn system_transfer_instruction_round_trips(from: [u8; 32], to: [u8; 32], lamports: u64) {
            let mut data = TRANSFER.to_le_bytes().to_vec();
            data.extend(lamports.to_le_bytes());
            let accounts = [Address::from_bytes(from), Address::from_bytes(to)];
            prop_assert_eq!(
                decode(&data, &accounts),
                Ok(SystemInstruction::Transfer {
                    from: accounts[0],
                    to: accounts[1],
                    lamports: Lamports(lamports),
                })
            );
        }
    }
}
