//! Reconcile token transfer receipts without inferring tax from a ledger residual.
use super::{Decoded, token_transfer};
use crate::book::BookError;
use binsight_solana::{
    Address,
    programs::{ProgramInstruction, TokenInstruction, TokenProgram},
    transaction::{InstructionPosition, TransactionView},
};

#[derive(Clone, Copy)]
pub(in crate::book) struct TransferLeg {
    pub(in crate::book) at: InstructionPosition,
    pub(in crate::book) source: Address,
    pub(in crate::book) destination: Address,
    pub(in crate::book) mint: Address,
    pub(in crate::book) amount: u128,
    pub(in crate::book) fee: u128,
}

pub(in crate::book) fn transfers(tx: &TransactionView, decoded: &Decoded) -> Vec<TransferLeg> {
    decoded
        .iter()
        .filter_map(|(at, instruction)| {
            token_transfer(instruction, tx).map(|(source, destination, mint, amount, fee)| {
                TransferLeg {
                    at: *at,
                    source,
                    destination,
                    mint,
                    amount,
                    fee,
                }
            })
        })
        .collect()
}

pub(in crate::book) fn received_fee(
    tx: &TransactionView,
    decoded: &Decoded,
    legs: &[TransferLeg],
    key: (Address, Address),
) -> Result<Option<u128>, BookError> {
    let (destination, mint) = key;
    let Some(balance) = tx.token_balances.iter().find(|balance| {
        balance.account == destination
            && balance.mint == mint
            && balance.program == TokenProgram::Token2022
    }) else {
        return Ok(None);
    };
    let mut gross = i128::try_from(balance.pre.0).map_err(|_| BookError::Overflow)?;
    for leg in legs.iter().filter(|leg| leg.mint == mint) {
        let amount = i128::try_from(leg.amount).map_err(|_| BookError::Overflow)?;
        if leg.destination == destination {
            gross = gross.checked_add(amount).ok_or(BookError::Overflow)?;
        }
        if leg.source == destination {
            gross = gross.checked_sub(amount).ok_or(BookError::Overflow)?;
        }
    }
    for (_, instruction) in decoded {
        let adjustment = match instruction {
            ProgramInstruction::Token {
                instruction:
                    TokenInstruction::MintTo {
                        mint: created,
                        account,
                        amount,
                        ..
                    },
                ..
            } if *account == destination && *created == mint => {
                Some(i128::try_from(amount.0).map_err(|_| BookError::Overflow)?)
            }
            ProgramInstruction::Token {
                instruction:
                    TokenInstruction::Burn {
                        mint: burned,
                        account,
                        amount,
                        ..
                    },
                ..
            } if *account == destination && *burned == mint => Some(
                i128::try_from(amount.0)
                    .map_err(|_| BookError::Overflow)?
                    .checked_neg()
                    .ok_or(BookError::Overflow)?,
            ),
            _ => None,
        };
        if let Some(amount) = adjustment {
            gross = gross.checked_add(amount).ok_or(BookError::Overflow)?;
        }
    }
    let post = i128::try_from(balance.post.0).map_err(|_| BookError::Overflow)?;
    let withheld = gross.checked_sub(post).ok_or(BookError::Overflow)?;
    if withheld < 0 {
        return Ok(None);
    }
    Ok(Some(
        u128::try_from(withheld).map_err(|_| BookError::Overflow)?,
    ))
}
