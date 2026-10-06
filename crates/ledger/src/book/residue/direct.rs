//! Preserve each direct capital counterparty and record recipient transfer tax separately.
use super::{account_owner, capital, is_wallet_signer, native_funding};
use crate::book::instructions::{Decoded, received_fee, transfers};
use crate::book::worksheet::Worksheet;
use crate::book::{Asset, BookError, Counterparty, EntryKind, WalletContext};
use crate::counterparties::landing_service;
use binsight_solana::{
    Address,
    programs::{ProgramInstruction, TokenInstruction},
    transaction::TransactionView,
};

pub(super) fn book(
    wallet: &WalletContext,
    tx: &TransactionView,
    decoded: &Decoded,
    sheet: &mut Worksheet,
) -> Result<(), BookError> {
    let mut own_accounts: Vec<_> = tx
        .token_balances
        .iter()
        .filter(|balance| {
            balance.owner_pre == Some(wallet.wallet) || balance.owner_post == Some(wallet.wallet)
        })
        .map(|balance| balance.account)
        .collect();
    for (_, instruction) in decoded {
        if let ProgramInstruction::Token {
            instruction: TokenInstruction::InitializeAccount { account, owner, .. },
            ..
        } = instruction
            && *owner == wallet.wallet
            && !own_accounts.contains(account)
        {
            own_accounts.push(*account);
        }
    }
    for (_, instruction) in decoded {
        if let Some((from, to, amount)) = native_funding(instruction) {
            if from == wallet.wallet && !is_wallet_signer(wallet.wallet, tx) {
                continue;
            }
            if own_accounts.contains(&from)
                || own_accounts.contains(&to)
                || wallet.positions.contains(&from)
                || wallet.positions.contains(&to)
                || landing_service(to).is_some()
            {
                continue;
            }
            book_transfer(
                wallet,
                sheet,
                Asset::Sol,
                (
                    account_owner(tx, from).unwrap_or(from),
                    account_owner(tx, to).unwrap_or(to),
                    amount,
                ),
            )?;
        }
    }
    book_tokens(wallet, tx, decoded, sheet)?;
    Ok(())
}

fn book_transfer(
    wallet: &WalletContext,
    sheet: &mut Worksheet,
    asset: Asset,
    transfer: (Address, Address, i128),
) -> Result<(), BookError> {
    let (from, to, amount) = transfer;
    if from == to {
        return Ok(());
    }
    let (other, amount) = if from == wallet.wallet {
        (to, amount.checked_neg().ok_or(BookError::Overflow)?)
    } else if to == wallet.wallet {
        (from, amount)
    } else {
        return Ok(());
    };
    let counterparty = if wallet.is_tracked(other) {
        Counterparty::TrackedWallet(other)
    } else {
        Counterparty::External {
            address: Some(other),
        }
    };
    sheet.book(asset, amount, capital(amount, counterparty))
}

fn book_tokens(
    wallet: &WalletContext,
    tx: &TransactionView,
    decoded: &Decoded,
    sheet: &mut Worksheet,
) -> Result<(), BookError> {
    let legs = transfers(tx, decoded);
    let mut recipients = Vec::new();
    for leg in &legs {
        let balance = |account| {
            tx.token_balances
                .iter()
                .find(|balance| balance.account == account && balance.mint == leg.mint)
        };
        let from = balance(leg.source).and_then(|balance| balance.owner_pre.or(balance.owner_post));
        let to =
            balance(leg.destination).and_then(|balance| balance.owner_post.or(balance.owner_pre));
        if let (Some(from), Some(to)) = (from, to)
            && (from != wallet.wallet || is_wallet_signer(wallet.wallet, tx))
        {
            book_transfer(
                wallet,
                sheet,
                Asset::Token { mint: leg.mint },
                (
                    from,
                    to,
                    i128::try_from(leg.amount).map_err(|_| BookError::Overflow)?,
                ),
            )?;
        }
        let key = (leg.destination, leg.mint);
        if to != Some(wallet.wallet) || recipients.contains(&key) {
            continue;
        }
        recipients.push(key);
        let explicit = legs
            .iter()
            .filter(|leg| (leg.destination, leg.mint) == key)
            .try_fold(0_u128, |total, leg| {
                total.checked_add(leg.fee).ok_or(BookError::Overflow)
            })?;
        let fee = received_fee(tx, decoded, &legs, key)?.unwrap_or(explicit);
        sheet.book(
            Asset::Token { mint: leg.mint },
            i128::try_from(fee)
                .map_err(|_| BookError::Overflow)?
                .checked_neg()
                .ok_or(BookError::Overflow)?,
            EntryKind::TransferFee,
        )?;
    }
    Ok(())
}
