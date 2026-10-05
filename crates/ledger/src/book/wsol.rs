//! Reconcile native funding and closing of owned wrapped-SOL accounts, including ephemeral ones.
//!
//! A net wrap pairs SOL and wSOL to the unit. Simulating account lamports follows actual token
//! transfers, so an account absent from both balance snapshots still has a known close payout.
use super::instructions::{Decoded, native_transfer, token_transfer};
use super::real_deltas::RealDeltas;
use super::worksheet::Worksheet;
use super::{Asset, BookError, EntryKind};
use binsight_solana::transaction::TransactionView;
use binsight_solana::well_known::WSOL_MINT;
use binsight_solana::{
    Address,
    programs::{ProgramInstruction, SystemInstruction, TokenInstruction},
};

#[derive(Clone, Copy)]
pub(super) struct WrapSources<'a> {
    pub(super) wallet: Address,
    pub(super) tx: &'a TransactionView,
    pub(super) decoded: &'a Decoded,
    pub(super) deltas: &'a RealDeltas,
}

pub(super) fn book(sources: WrapSources<'_>, sheet: &mut Worksheet) -> Result<(), BookError> {
    let WrapSources {
        wallet,
        tx,
        decoded,
        deltas,
    } = sources;
    let mut accounts: Vec<_> = tx
        .token_balances
        .iter()
        .filter(|balance| {
            balance.mint == WSOL_MINT
                && (balance.owner_pre == Some(wallet) || balance.owner_post == Some(wallet))
        })
        .map(|balance| balance.account)
        .collect();
    for (_, instruction) in decoded {
        if let ProgramInstruction::Token {
            instruction:
                TokenInstruction::InitializeAccount {
                    account,
                    mint,
                    owner,
                },
            ..
        } = instruction
            && *mint == WSOL_MINT
            && *owner == wallet
            && !accounts.contains(account)
        {
            accounts.push(*account);
        }
    }
    let mut native: Vec<_> = accounts
        .iter()
        .map(|&account| {
            (
                account,
                tx.native_balances
                    .iter()
                    .find(|balance| balance.account == account)
                    .map_or(0, |balance| i128::from(balance.pre.0)),
            )
        })
        .collect();
    let mut funding = 0_i128;
    for (_, instruction) in decoded {
        apply(wallet, tx, instruction, (&mut native, &mut funding))?;
    }
    let rent = deltas
        .rent
        .iter()
        .filter(|rent| accounts.contains(&rent.account))
        .try_fold(0_i128, |total, rent| {
            total
                .checked_add(super::rent::wallet_exchange_change(
                    wallet, tx, decoded, rent,
                ))
                .ok_or(BookError::Overflow)
        })?;
    let wrapped = funding.checked_sub(rent).ok_or(BookError::Overflow)?;
    if wrapped != 0 {
        let kind = if wrapped > 0 {
            EntryKind::Wrap
        } else {
            EntryKind::Unwrap
        };
        sheet.book(
            Asset::Sol,
            wrapped.checked_neg().ok_or(BookError::Overflow)?,
            kind,
        )?;
        sheet.book(Asset::Token { mint: WSOL_MINT }, wrapped, kind)?;
    }
    Ok(())
}

fn apply(
    wallet: Address,
    tx: &TransactionView,
    instruction: &ProgramInstruction,
    state: (&mut [(Address, i128)], &mut i128),
) -> Result<(), BookError> {
    let (native, funding) = state;
    if let Some((from, to, amount)) = native_transfer(instruction) {
        move_lamports(wallet, native, funding, (from, to, amount))?;
    }
    if let ProgramInstruction::System(
        SystemInstruction::CreateAccount {
            funder,
            account,
            lamports,
            ..
        }
        | SystemInstruction::CreateAccountWithSeed {
            funder,
            account,
            lamports,
            ..
        },
    ) = instruction
    {
        move_lamports(
            wallet,
            native,
            funding,
            (*funder, *account, i128::from(lamports.0)),
        )?;
    }
    if let Some((source, destination, mint, amount, _)) = token_transfer(instruction, tx)
        && (mint == WSOL_MINT
            || native
                .iter()
                .any(|&(account, _)| account == source || account == destination))
    {
        let amount = i128::try_from(amount).map_err(|_| BookError::Overflow)?;
        change(
            native,
            source,
            amount.checked_neg().ok_or(BookError::Overflow)?,
        )?;
        change(native, destination, amount)?;
    }
    if let ProgramInstruction::Token {
        instruction:
            TokenInstruction::CloseAccount {
                account,
                destination,
                ..
            },
        ..
    } = instruction
        && let Some((_, amount)) = native.iter_mut().find(|(known, _)| known == account)
    {
        if *destination == wallet {
            *funding = funding.checked_sub(*amount).ok_or(BookError::Overflow)?;
        }
        *amount = 0;
    }
    Ok(())
}

fn move_lamports(
    wallet: Address,
    native: &mut [(Address, i128)],
    funding: &mut i128,
    transfer: (Address, Address, i128),
) -> Result<(), BookError> {
    let (from, to, amount) = transfer;
    if from == wallet && native.iter().any(|&(account, _)| account == to) {
        *funding = funding.checked_add(amount).ok_or(BookError::Overflow)?;
    }
    if to == wallet && native.iter().any(|&(account, _)| account == from) {
        *funding = funding.checked_sub(amount).ok_or(BookError::Overflow)?;
    }
    change(
        native,
        from,
        amount.checked_neg().ok_or(BookError::Overflow)?,
    )?;
    change(native, to, amount)
}

fn change(native: &mut [(Address, i128)], account: Address, amount: i128) -> Result<(), BookError> {
    if let Some((_, balance)) = native.iter_mut().find(|(known, _)| *known == account) {
        *balance = balance.checked_add(amount).ok_or(BookError::Overflow)?;
    }
    Ok(())
}
