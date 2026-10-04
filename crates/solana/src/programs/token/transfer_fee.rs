//! The Token-2022 transfer-fee extension: discriminator 26, then a sub-instruction byte.
//!
//! Three of its instructions move tokens into an account's amount: the transfer that states its
//! fee, and the two withdrawals of withheld fees (whose amounts are only in the balances). The
//! others set the fee or harvest withheld fees into the mint, which changes no account's amount.
//! This module only decodes; SPL Token has no such extension, and [`super::decode`] only calls it
//! for Token-2022.

use super::{TokenInstruction, read_amount, read_checked_transfer};
use crate::Address;
use crate::programs::InstructionDecodeError;
use crate::programs::instruction_reader::{InstructionAccounts, InstructionFields};

/// The name used in errors.
const PROGRAM: &str = "Token-2022 transfer fee";

const TRANSFER_CHECKED_WITH_FEE: u8 = 1;
const WITHDRAW_WITHHELD_TOKENS_FROM_MINT: u8 = 2;
const WITHDRAW_WITHHELD_TOKENS_FROM_ACCOUNTS: u8 = 3;

/// The position of the withdraw authority; the multisig signers, if any, follow it.
const AUTHORITY_POSITION: usize = 2;

/// Decodes the instruction after the extension's discriminator, already read from `fields`.
pub(super) fn decode(
    fields: &mut InstructionFields<'_>,
    account_list: &[Address],
) -> Result<TokenInstruction, InstructionDecodeError> {
    let instruction = fields.u8("the transfer-fee instruction")?;
    let accounts = InstructionAccounts::new(account_list, PROGRAM, instruction_name(instruction));
    Ok(match instruction {
        TRANSFER_CHECKED_WITH_FEE => TokenInstruction::TransferCheckedWithFee {
            transfer: read_checked_transfer(fields, &accounts)?,
            fee: read_amount(fields, "the fee")?,
        },
        WITHDRAW_WITHHELD_TOKENS_FROM_MINT => TokenInstruction::WithdrawWithheldTokensFromMint {
            mint: accounts.at(0)?,
            destination: accounts.at(1)?,
            authority: accounts.at(AUTHORITY_POSITION)?,
        },
        WITHDRAW_WITHHELD_TOKENS_FROM_ACCOUNTS => {
            let source_count = usize::from(fields.u8("the number of source accounts")?);
            TokenInstruction::WithdrawWithheldTokensFromAccounts {
                mint: accounts.at(0)?,
                destination: accounts.at(1)?,
                authority: accounts.at(AUTHORITY_POSITION)?,
                sources: accounts.last(source_count, AUTHORITY_POSITION)?,
            }
        }
        instruction => TokenInstruction::OtherTransferFee { instruction },
    })
}

/// The name of an instruction, for errors.
fn instruction_name(instruction: u8) -> &'static str {
    match instruction {
        TRANSFER_CHECKED_WITH_FEE => "TransferCheckedWithFee",
        WITHDRAW_WITHHELD_TOKENS_FROM_MINT => "WithdrawWithheldTokensFromMint",
        WITHDRAW_WITHHELD_TOKENS_FROM_ACCOUNTS => "WithdrawWithheldTokensFromAccounts",
        _ => "Other",
    }
}

#[cfg(test)]
mod tests {
    use binsight_core::units::{Decimals, RawTokenAmount};

    use super::*;
    use crate::programs::TokenProgram;
    use crate::programs::token::{CheckedTransfer, TRANSFER_FEE_EXTENSION};

    fn address(byte: u8) -> Address {
        Address::from_bytes([byte; 32])
    }

    fn decode_2022(
        data: &[u8],
        accounts: &[Address],
    ) -> Result<TokenInstruction, InstructionDecodeError> {
        super::super::decode(TokenProgram::Token2022, data, accounts)
    }

    #[test]
    fn decodes_transfer_checked_with_fee_and_its_withheld_fee() {
        let mut data = vec![TRANSFER_FEE_EXTENSION, TRANSFER_CHECKED_WITH_FEE];
        data.extend(1_000_000_u64.to_le_bytes());
        data.push(6);
        data.extend(10_000_u64.to_le_bytes());
        let accounts = [address(1), address(2), address(3), address(4)];
        assert_eq!(
            decode_2022(&data, &accounts),
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
    fn names_a_withdrawal_of_the_fees_withheld_in_the_mint() {
        let data = [TRANSFER_FEE_EXTENSION, WITHDRAW_WITHHELD_TOKENS_FROM_MINT];
        assert_eq!(
            decode_2022(&data, &[address(1), address(2), address(3)]),
            Ok(TokenInstruction::WithdrawWithheldTokensFromMint {
                mint: address(1),
                destination: address(2),
                authority: address(3),
            })
        );
    }

    #[test]
    fn reads_the_sources_of_a_withdrawal_after_the_multisig_signers() {
        let data = [
            TRANSFER_FEE_EXTENSION,
            WITHDRAW_WITHHELD_TOKENS_FROM_ACCOUNTS,
            2,
        ];
        let accounts = [
            address(1),
            address(2),
            address(3),
            address(9),
            address(5),
            address(6),
        ];
        assert_eq!(
            decode_2022(&data, &accounts),
            Ok(TokenInstruction::WithdrawWithheldTokensFromAccounts {
                mint: address(1),
                destination: address(2),
                authority: address(3),
                sources: vec![address(5), address(6)],
            })
        );
        assert!(decode_2022(&data, &accounts[..4]).is_err());
    }

    #[test]
    fn keeps_the_other_transfer_fee_instructions_with_their_number() {
        let harvest = [TRANSFER_FEE_EXTENSION, 4];
        assert_eq!(
            decode_2022(&harvest, &[address(1)]),
            Ok(TokenInstruction::OtherTransferFee { instruction: 4 })
        );
    }
}
