//! What a transaction really changed for a wallet: its SOL, its tokens and its rent.
//!
//! - **SOL** is the change of the lamports of the wallet's own account.
//! - **Tokens** are counted per mint over the token accounts the wallet owns: an account counts
//!   its amount before only if the wallet owned it before, and its amount after only if the
//!   wallet owns it after. A change of owner is a token crossing the wallet's boundary, and two
//!   accounts of the wallet exchanging tokens change nothing.
//! - **Rent** is the change of the lamports of the accounts the wallet owns, per account: its
//!   token accounts (apart from the tokens of a wrapped-SOL account, which are lamports too) and
//!   its positions.
//!
//! The order of the balances in the meta changes nothing. This module measures; it does not
//! explain.

use binsight_core::units::{Lamports, RawTokenAmount};
use binsight_solana::Address;
use binsight_solana::transaction::{TokenBalance, TransactionView};
use binsight_solana::well_known::WSOL_MINT;

use super::BookError;
use super::context::OwnedPositions;
use super::entry::{Asset, RentPurpose};

/// The real changes of one transaction for one wallet.
pub(super) struct RealDeltas {
    /// The change of the wallet's lamports.
    pub(super) sol: i128,
    /// The change of the rent of each account the wallet owns, per account (accounts that did
    /// not change are left out), sorted by account.
    pub(super) rent: Vec<AccountRent>,
    /// The change of each mint, sorted by mint (mints that did not change are left out).
    pub(super) tokens: Vec<(Address, i128)>,
    /// The token accounts the wallet owns before or after the transaction.
    pub(super) token_accounts: Vec<Address>,
}

/// The change of the rent locked in one account of the wallet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AccountRent {
    /// The account.
    pub(super) account: Address,
    /// What it is.
    pub(super) purpose: RentPurpose,
    /// The change, in lamports.
    pub(super) change: i128,
}

/// Measures what `tx` changed for `wallet`, whose positions are `positions`.
pub(super) fn measure(
    wallet: Address,
    positions: &OwnedPositions<'_>,
    tx: &TransactionView,
) -> Result<RealDeltas, BookError> {
    let mut deltas = RealDeltas {
        sol: lamports_change(tx, wallet),
        rent: Vec::new(),
        tokens: Vec::new(),
        token_accounts: Vec::new(),
    };
    for balance in &tx.token_balances {
        add_token_account(&mut deltas, wallet, balance)?;
    }
    if let Some(account) = deltas.token_accounts.iter().find(|&&account| {
        !tx.native_balances
            .iter()
            .any(|native| native.account == account)
    }) {
        return Err(BookError::TokenAccountWithoutLamports { account: *account });
    }
    for native in &tx.native_balances {
        let tokens: Vec<_> = tx
            .token_balances
            .iter()
            .filter(|balance| balance.account == native.account)
            .collect();
        let owns_before = tokens
            .iter()
            .any(|balance| balance.owner_pre == Some(wallet));
        let owns_after = tokens
            .iter()
            .any(|balance| balance.owner_post == Some(wallet));
        if owns_before || owns_after {
            let reserved = |before: bool| -> Result<i128, BookError> {
                let owned = if before { owns_before } else { owns_after };
                if !owned {
                    return Ok(0);
                }
                let lamports = if before { native.pre } else { native.post };
                let wrapped = tokens
                    .iter()
                    .filter(|balance| balance.mint == WSOL_MINT)
                    .try_fold(0_i128, |total, balance| {
                        let raw = if before {
                            balance.pre.0
                        } else {
                            balance.post.0
                        };
                        let amount = i128::try_from(raw).map_err(|_| BookError::Overflow)?;
                        total.checked_add(amount).ok_or(BookError::Overflow)
                    })?;
                i128::from(lamports.0)
                    .checked_sub(wrapped)
                    .ok_or(BookError::Overflow)
            };
            add(
                &mut deltas.rent,
                native.account,
                RentPurpose::TokenAccount,
                difference(reserved(false)?, reserved(true)?)?,
            )?;
        } else if positions.owns(native.account) {
            add(
                &mut deltas.rent,
                native.account,
                RentPurpose::Position,
                signed_change(native.pre, native.post),
            )?;
        }
    }
    deltas.rent.retain(|rent| rent.change != 0);
    deltas.rent.sort_unstable_by_key(|rent| rent.account);
    deltas.tokens.retain(|&(_, change)| change != 0);
    deltas.tokens.sort_unstable_by_key(|&(mint, _)| mint);
    Ok(deltas)
}

impl RealDeltas {
    /// The change of every asset.
    pub(super) fn per_asset(&self) -> Result<Vec<(Asset, i128)>, BookError> {
        let rent = self.rent.iter().try_fold(0_i128, |total, rent| {
            total.checked_add(rent.change).ok_or(BookError::Overflow)
        })?;
        let mut changes = vec![(Asset::Sol, self.sol), (Asset::Rent, rent)];
        changes.extend(
            self.tokens
                .iter()
                .map(|&(mint, change)| (Asset::Token { mint }, change)),
        );
        changes.retain(|&(_, change)| change != 0);
        Ok(changes)
    }

    /// Whether the wallet owns the token account `account` before or after the transaction.
    pub(super) fn owns_token_account(&self, account: Address) -> bool {
        self.token_accounts.contains(&account)
    }
}

/// Adds what one token account of `tx` changed for `wallet`: its tokens and its rent.
fn add_token_account(
    deltas: &mut RealDeltas,
    wallet: Address,
    balance: &TokenBalance,
) -> Result<(), BookError> {
    let owned_before = balance.owner_pre == Some(wallet);
    let owned_after = balance.owner_post == Some(wallet);
    if !owned_before && !owned_after {
        return Ok(());
    }
    if !deltas.token_accounts.contains(&balance.account) {
        deltas.token_accounts.push(balance.account);
    }
    let amount = |owned: bool, raw: RawTokenAmount| -> Result<i128, BookError> {
        if !owned {
            return Ok(0);
        }
        i128::try_from(raw.0).map_err(|_| BookError::Overflow)
    };
    let change = difference(
        amount(owned_after, balance.post)?,
        amount(owned_before, balance.pre)?,
    )?;
    add_mint(&mut deltas.tokens, balance.mint, change)
}

fn add(
    rents: &mut Vec<AccountRent>,
    account: Address,
    purpose: RentPurpose,
    change: i128,
) -> Result<(), BookError> {
    match rents.iter_mut().find(|rent| rent.account == account) {
        Some(rent) => rent.change = rent.change.checked_add(change).ok_or(BookError::Overflow)?,
        None => rents.push(AccountRent {
            account,
            purpose,
            change,
        }),
    }
    Ok(())
}

fn add_mint(
    tokens: &mut Vec<(Address, i128)>,
    mint: Address,
    change: i128,
) -> Result<(), BookError> {
    match tokens.iter_mut().find(|(known, _)| *known == mint) {
        Some((_, total)) => *total = total.checked_add(change).ok_or(BookError::Overflow)?,
        None => tokens.push((mint, change)),
    }
    Ok(())
}

fn difference(after: i128, before: i128) -> Result<i128, BookError> {
    after.checked_sub(before).ok_or(BookError::Overflow)
}

/// The change of the lamports of `account` in `tx` (zero when the transaction does not name it).
pub(super) fn lamports_change(tx: &TransactionView, account: Address) -> i128 {
    tx.native_balances
        .iter()
        .find(|native| native.account == account)
        .map_or(0, |native| signed_change(native.pre, native.post))
}

#[expect(
    clippy::arithmetic_side_effects,
    reason = "the difference of two u64 values always fits i128"
)]
fn signed_change(pre: Lamports, post: Lamports) -> i128 {
    // Two u64 always fit an i128 and their difference never overflows it.
    i128::from(post.0) - i128::from(pre.0)
}
