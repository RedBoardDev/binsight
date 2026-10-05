//! Decode native instructions once and expose their transfer legs to booking stages.
mod transfer_fee;
pub(super) use transfer_fee::{TransferLeg, received_fee, transfers};

use super::real_deltas::RealDeltas;
use super::worksheet::Worksheet;
use super::{Asset, BookError, EntryKind};
use binsight_solana::Address;
use binsight_solana::programs::{self, ProgramInstruction, SystemInstruction, TokenInstruction};
use binsight_solana::transaction::{InstructionPosition, TransactionView};

pub(super) type Decoded = Vec<(InstructionPosition, ProgramInstruction)>;

pub(super) fn decode(tx: &TransactionView) -> Result<Decoded, BookError> {
    tx.instructions
        .iter()
        .filter_map(|node| match programs::decode(node) {
            Ok(Some(instruction)) => Some(Ok((node.position, instruction))),
            Ok(None) => None,
            Err(error) => Some(Err(BookError::Instruction(error))),
        })
        .collect()
}

pub(super) fn native_transfer(
    instruction: &ProgramInstruction,
) -> Option<(Address, Address, i128)> {
    match *instruction {
        ProgramInstruction::System(
            SystemInstruction::Transfer { from, to, lamports }
            | SystemInstruction::TransferWithSeed { from, to, lamports },
        ) => Some((from, to, i128::from(lamports.0))),
        _ => None,
    }
}

pub(super) fn token_transfer(
    instruction: &ProgramInstruction,
    tx: &TransactionView,
) -> Option<(Address, Address, Address, u128, u128)> {
    let ProgramInstruction::Token { instruction, .. } = instruction else {
        return None;
    };
    match instruction {
        TokenInstruction::Transfer {
            source,
            destination,
            amount,
            ..
        } => {
            let mint = tx
                .token_balances
                .iter()
                .find(|balance| balance.account == *source || balance.account == *destination)?
                .mint;
            Some((*source, *destination, mint, amount.0, 0))
        }
        TokenInstruction::TransferChecked(transfer) => Some((
            transfer.source,
            transfer.destination,
            transfer.mint,
            transfer.amount.0,
            0,
        )),
        TokenInstruction::TransferCheckedWithFee { transfer, fee } => Some((
            transfer.source,
            transfer.destination,
            transfer.mint,
            transfer.amount.0,
            fee.0,
        )),
        _ => None,
    }
}

pub(super) fn book_burns(
    decoded: &Decoded,
    deltas: &RealDeltas,
    sheet: &mut Worksheet,
) -> Result<(), BookError> {
    for (_, instruction) in decoded {
        if let ProgramInstruction::Token {
            instruction:
                TokenInstruction::Burn {
                    account,
                    mint,
                    amount,
                    ..
                },
            ..
        } = instruction
            && deltas.owns_token_account(*account)
        {
            let amount = i128::try_from(amount.0).map_err(|_| BookError::Overflow)?;
            sheet.book(
                Asset::Token { mint: *mint },
                amount.checked_neg().ok_or(BookError::Overflow)?,
                EntryKind::Burn,
            )?;
        }
    }
    Ok(())
}
