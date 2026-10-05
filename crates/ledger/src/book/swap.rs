//! Identify exchange legs after position movements, rent and wraps have been removed.
//!
//! Only a non-direct program transaction can be a swap. Intermediate mints whose net outflow
//! is at most one percent of their gross outflow are left as protocol changes.
use super::instructions::{Decoded, token_transfer};
use super::residue::is_direct;
use super::worksheet::Worksheet;
use super::{Asset, BookError, EntryKind, WalletContext};
use binsight_solana::{Address, transaction::TransactionView};

pub(super) fn book(
    wallet: &WalletContext,
    tx: &TransactionView,
    decoded: &Decoded,
    sheet: &mut Worksheet,
) -> Result<(), BookError> {
    if is_direct(tx)
        || tx.instructions.iter().any(|node| {
            node.position.inner.is_none()
                && (wallet.bridges.contains_key(&node.program)
                    || wallet.services.contains(&node.program))
        })
    {
        return Ok(());
    }
    let residues = sheet.residues();
    let mut legs = Vec::new();
    for (asset, amount) in residues {
        if asset == Asset::Rent {
            continue;
        }
        if amount < 0 && !has_meaningful_outflow(wallet.wallet, tx, decoded, (asset, amount))? {
            continue;
        }
        legs.push((asset, amount));
    }
    if !legs.iter().any(|&(_, amount)| amount < 0) || !legs.iter().any(|&(_, amount)| amount > 0) {
        return Ok(());
    }
    for (asset, amount) in legs {
        let kind = if amount < 0 {
            EntryKind::SwapOut
        } else {
            EntryKind::SwapIn
        };
        sheet.book(asset, amount, kind)?;
    }
    Ok(())
}

fn has_meaningful_outflow(
    wallet: Address,
    tx: &TransactionView,
    decoded: &Decoded,
    leg: (Asset, i128),
) -> Result<bool, BookError> {
    let (asset, amount) = leg;
    let Asset::Token { mint } = asset else {
        return Ok(true);
    };
    let gross = decoded
        .iter()
        .filter_map(|(_, instruction)| token_transfer(instruction, tx))
        .filter(|(source, _, token_mint, _, _)| {
            *token_mint == mint
                && tx
                    .token_balances
                    .iter()
                    .any(|balance| balance.account == *source && balance.owner_pre == Some(wallet))
        })
        .try_fold(0_u128, |total, (_, _, _, amount, _)| {
            total.checked_add(amount).ok_or(BookError::Overflow)
        })?;
    let net = amount.unsigned_abs();
    Ok(gross == 0 || net.checked_mul(100).ok_or(BookError::Overflow)? > gross)
}
