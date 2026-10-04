//! The SPL Token and Token-2022 instructions that move, create or destroy tokens.
//!
//! Both programs share the layout of their base instructions: a `u8` discriminator, then
//! little-endian fields. Token-2022 adds extensions; of those, binsight decodes the transfer-fee
//! extension, whose instructions move tokens ([`transfer_fee`]). SPL Token has no extension, so
//! the same discriminator there is [`TokenInstruction::Other`]. Like the programs, the decoder
//! ignores bytes after the fields. Approvals, authorities and freezes are `Other` too.

mod transfer_fee;

use binsight_core::units::{Decimals, RawTokenAmount};

use super::instruction_reader::{InstructionAccounts, InstructionFields};
use super::{InstructionDecodeError, TokenProgram};
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
    /// Token-2022: moves the transfer fees withheld in the mint into `destination`'s amount. The
    /// data holds no amount: it is in the balances.
    WithdrawWithheldTokensFromMint {
        /// The mint.
        mint: Address,
        /// The account that receives.
        destination: Address,
        /// The withdraw authority.
        authority: Address,
    },
    /// Token-2022: moves the transfer fees withheld in `sources` into `destination`'s amount. The
    /// data holds no amount: it is in the balances.
    WithdrawWithheldTokensFromAccounts {
        /// The mint.
        mint: Address,
        /// The account that receives.
        destination: Address,
        /// The withdraw authority.
        authority: Address,
        /// The accounts the withheld fees come from.
        sources: Vec<Address>,
    },
    /// Token-2022: another instruction of the transfer-fee extension (setting the fee, or
    /// harvesting withheld fees into the mint), which changes no account's amount.
    OtherTransferFee {
        /// Its discriminator inside the extension.
        instruction: u8,
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

/// Decodes an instruction of the token `program` from its data and accounts.
pub(super) fn decode(
    program: TokenProgram,
    data: &[u8],
    account_list: &[Address],
) -> Result<TokenInstruction, InstructionDecodeError> {
    let mut fields = InstructionFields::new(data, PROGRAM);
    let discriminator = fields.u8("the instruction")?;
    if discriminator == TRANSFER_FEE_EXTENSION && program == TokenProgram::Token2022 {
        return transfer_fee::decode(&mut fields, account_list);
    }
    let accounts = InstructionAccounts::new(account_list, PROGRAM, instruction_name(discriminator));
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
    fn keeps_the_transfer_fee_discriminator_unread_under_spl_token() {
        let data = [TRANSFER_FEE_EXTENSION, 1, 0, 0];
        assert_eq!(
            decode(TokenProgram::Token, &data, &[]),
            Ok(TokenInstruction::Other {
                discriminator: TRANSFER_FEE_EXTENSION
            })
        );
    }

    #[test]
    fn reads_the_owner_of_initialize_account_3_from_its_data() {
        let mut data = vec![INITIALIZE_ACCOUNT_3];
        data.extend([7; 32]);
        assert_eq!(
            decode(TokenProgram::Token, &data, &[address(1), address(2)]),
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
            decode(TokenProgram::Token, &data, &accounts),
            Err(InstructionDecodeError::Malformed { .. })
        ));
    }
}
