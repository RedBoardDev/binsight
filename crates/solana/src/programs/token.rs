//! The SPL Token and Token-2022 instructions that move, create or destroy tokens.
//!
//! Both programs share the layout of their base instructions: a `u8` discriminator, then
//! little-endian fields. Token-2022 adds extensions; of those, binsight decodes the transfer with
//! an explicit fee (`TransferFeeExtension` → `TransferCheckedWithFee`). Like the programs, the
//! decoder ignores bytes after the fields. Approvals, authorities and freezes are
//! [`TokenInstruction::Other`]. Which of the two programs ran an instruction is in
//! [`super::TokenProgram`].

use binsight_core::units::{Decimals, RawTokenAmount};

use super::InstructionDecodeError;
use super::instruction_reader::{InstructionAccounts, InstructionFields};
use crate::Address;

/// The name used in errors.
const PROGRAM: &str = "Token";

const INITIALIZE_ACCOUNT: u8 = 1;
const TRANSFER: u8 = 3;
const MINT_TO: u8 = 7;
const BURN: u8 = 8;
const CLOSE_ACCOUNT: u8 = 9;
const TRANSFER_CHECKED: u8 = 12;
const MINT_TO_CHECKED: u8 = 14;
const BURN_CHECKED: u8 = 15;
const INITIALIZE_ACCOUNT_2: u8 = 16;
const SYNC_NATIVE: u8 = 17;
const INITIALIZE_ACCOUNT_3: u8 = 18;
const TRANSFER_FEE_EXTENSION: u8 = 26;

/// The `TransferCheckedWithFee` instruction inside the transfer-fee extension.
const TRANSFER_CHECKED_WITH_FEE: u8 = 1;

/// A token program instruction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenInstruction {
    /// Moves tokens between two accounts (no mint given).
    Transfer {
        /// The account that sends.
        source: Address,
        /// The account that receives.
        destination: Address,
        /// The owner or delegate that signs.
        authority: Address,
        /// The amount taken from `source`.
        amount: RawTokenAmount,
    },
    /// Moves tokens, checking the mint and its decimals.
    TransferChecked(CheckedTransfer),
    /// Token-2022: moves tokens and states the transfer fee withheld from them.
    TransferCheckedWithFee {
        /// The transfer; `destination` receives `amount - fee`.
        transfer: CheckedTransfer,
        /// The fee withheld in `destination`.
        fee: RawTokenAmount,
    },
    /// Initializes a token account (any of the three variants).
    InitializeAccount {
        /// The token account.
        account: Address,
        /// Its mint.
        mint: Address,
        /// Its owner.
        owner: Address,
    },
    /// Closes a token account and sends its lamports to `destination`.
    CloseAccount {
        /// The closed account.
        account: Address,
        /// Receives the lamports.
        destination: Address,
        /// The owner or close authority that signs.
        owner: Address,
    },
    /// Sets the token amount of a wrapped-SOL account to its lamports above rent.
    SyncNative {
        /// The wrapped-SOL account.
        account: Address,
    },
    /// Creates tokens (with or without a decimals check).
    MintTo {
        /// The mint.
        mint: Address,
        /// The account that receives.
        account: Address,
        /// The mint authority.
        authority: Address,
        /// The amount created.
        amount: RawTokenAmount,
    },
    /// Destroys tokens (with or without a decimals check).
    Burn {
        /// The account the tokens are taken from.
        account: Address,
        /// The mint.
        mint: Address,
        /// The owner or delegate that signs.
        authority: Address,
        /// The amount destroyed.
        amount: RawTokenAmount,
    },
    /// Another instruction (approvals, authorities, freezes, other extensions).
    Other {
        /// Its discriminator.
        discriminator: u8,
    },
}

/// A transfer that names its mint and checks its decimals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckedTransfer {
    /// The account that sends.
    pub source: Address,
    /// The mint.
    pub mint: Address,
    /// The account that receives.
    pub destination: Address,
    /// The owner or delegate that signs.
    pub authority: Address,
    /// The amount taken from `source`.
    pub amount: RawTokenAmount,
    /// The decimals of the mint.
    pub decimals: Decimals,
}

/// Decodes a token instruction from its data and accounts.
pub(super) fn decode(
    data: &[u8],
    accounts: &[Address],
) -> Result<TokenInstruction, InstructionDecodeError> {
    let mut fields = InstructionFields::new(data, PROGRAM);
    let discriminator = fields.u8("the instruction")?;
    let accounts = InstructionAccounts::new(accounts, PROGRAM, instruction_name(discriminator));
    let instruction = match discriminator {
        TRANSFER => TokenInstruction::Transfer {
            source: accounts.at(0)?,
            destination: accounts.at(1)?,
            authority: accounts.at(2)?,
            amount: read_amount(&mut fields, "the amount")?,
        },
        TRANSFER_CHECKED => {
            TokenInstruction::TransferChecked(read_checked_transfer(&mut fields, &accounts)?)
        }
        TRANSFER_FEE_EXTENSION => return decode_transfer_fee_extension(&mut fields, &accounts),
        INITIALIZE_ACCOUNT => TokenInstruction::InitializeAccount {
            account: accounts.at(0)?,
            mint: accounts.at(1)?,
            owner: accounts.at(2)?,
        },
        INITIALIZE_ACCOUNT_2 | INITIALIZE_ACCOUNT_3 => TokenInstruction::InitializeAccount {
            account: accounts.at(0)?,
            mint: accounts.at(1)?,
            owner: fields.address("the owner")?,
        },
        CLOSE_ACCOUNT => TokenInstruction::CloseAccount {
            account: accounts.at(0)?,
            destination: accounts.at(1)?,
            owner: accounts.at(2)?,
        },
        SYNC_NATIVE => TokenInstruction::SyncNative {
            account: accounts.at(0)?,
        },
        MINT_TO | MINT_TO_CHECKED => TokenInstruction::MintTo {
            mint: accounts.at(0)?,
            account: accounts.at(1)?,
            authority: accounts.at(2)?,
            amount: read_amount(&mut fields, "the amount")?,
        },
        BURN | BURN_CHECKED => TokenInstruction::Burn {
            account: accounts.at(0)?,
            mint: accounts.at(1)?,
            authority: accounts.at(2)?,
            amount: read_amount(&mut fields, "the amount")?,
        },
        discriminator => TokenInstruction::Other { discriminator },
    };
    Ok(instruction)
}

/// Decodes an instruction of the transfer-fee extension; only the transfer itself is booked.
fn decode_transfer_fee_extension(
    fields: &mut InstructionFields<'_>,
    accounts: &InstructionAccounts<'_>,
) -> Result<TokenInstruction, InstructionDecodeError> {
    if fields.u8("the transfer-fee instruction")? != TRANSFER_CHECKED_WITH_FEE {
        return Ok(TokenInstruction::Other {
            discriminator: TRANSFER_FEE_EXTENSION,
        });
    }
    Ok(TokenInstruction::TransferCheckedWithFee {
        transfer: read_checked_transfer(fields, accounts)?,
        fee: read_amount(fields, "the fee")?,
    })
}

/// The accounts, amount and decimals shared by both checked transfers, in data order.
fn read_checked_transfer(
    fields: &mut InstructionFields<'_>,
    accounts: &InstructionAccounts<'_>,
) -> Result<CheckedTransfer, InstructionDecodeError> {
    Ok(CheckedTransfer {
        source: accounts.at(0)?,
        mint: accounts.at(1)?,
        destination: accounts.at(2)?,
        authority: accounts.at(3)?,
        amount: read_amount(fields, "the amount")?,
        decimals: Decimals(fields.u8("the decimals")?),
    })
}

/// A token amount: a `u64` on chain, widened without loss.
fn read_amount(
    fields: &mut InstructionFields<'_>,
    what: &'static str,
) -> Result<RawTokenAmount, InstructionDecodeError> {
    fields
        .u64(what)
        .map(|amount| RawTokenAmount(u128::from(amount)))
}

/// The name of an instruction, for errors.
fn instruction_name(discriminator: u8) -> &'static str {
    match discriminator {
        TRANSFER => "Transfer",
        TRANSFER_CHECKED => "TransferChecked",
        TRANSFER_FEE_EXTENSION => "TransferCheckedWithFee",
        INITIALIZE_ACCOUNT | INITIALIZE_ACCOUNT_2 | INITIALIZE_ACCOUNT_3 => "InitializeAccount",
        CLOSE_ACCOUNT => "CloseAccount",
        SYNC_NATIVE => "SyncNative",
        MINT_TO | MINT_TO_CHECKED => "MintTo",
        BURN | BURN_CHECKED => "Burn",
        _ => "Other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(byte: u8) -> Address {
        Address::from_bytes([byte; 32])
    }

    #[test]
    fn decodes_transfer_checked_with_fee_and_its_withheld_fee() {
        let mut data = vec![TRANSFER_FEE_EXTENSION, TRANSFER_CHECKED_WITH_FEE];
        data.extend(1_000_000_u64.to_le_bytes());
        data.push(6);
        data.extend(10_000_u64.to_le_bytes());
        let accounts = [address(1), address(2), address(3), address(4)];
        assert_eq!(
            decode(&data, &accounts),
            Ok(TokenInstruction::TransferCheckedWithFee {
                transfer: CheckedTransfer {
                    source: address(1),
                    mint: address(2),
                    destination: address(3),
                    authority: address(4),
                    amount: RawTokenAmount(1_000_000),
                    decimals: Decimals(6),
                },
                fee: RawTokenAmount(10_000),
            })
        );
    }

    #[test]
    fn reads_the_owner_of_initialize_account_3_from_its_data() {
        let mut data = vec![INITIALIZE_ACCOUNT_3];
        data.extend([7; 32]);
        assert_eq!(
            decode(&data, &[address(1), address(2)]),
            Ok(TokenInstruction::InitializeAccount {
                account: address(1),
                mint: address(2),
                owner: address(7),
            })
        );
    }

    #[test]
    fn refuses_a_transfer_whose_amount_is_cut_short() {
        let data = [TRANSFER, 1, 2];
        let accounts = [address(1), address(2), address(3)];
        assert!(matches!(
            decode(&data, &accounts),
            Err(InstructionDecodeError::Malformed { .. })
        ));
    }
}
