//! Preserve each direct capital counterparty and record recipient transfer tax separately.
//!
//! In a direct transaction every transfer with the wallet is capital. In a transaction of
//! another protocol, only the transfers with another tracked wallet are: the rest is the
//! protocol's activity.
use super::{TxSources, account_owner, capital, is_wallet_signer, native_funding};
use crate::book::instructions::{TransferLeg, received_fee, transfers, wallet_token_accounts};
use crate::book::worksheet::Worksheet;
use crate::book::{Asset, BookError, Counterparty, EntryKind};
use crate::counterparties::landing_service;
use binsight_solana::Address;
use binsight_solana::transaction::TokenBalance;

/// Which transfers count as capital.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TransferScope {
    /// Every transfer with the wallet (a direct transaction).
    AnyCounterparty,
    /// Only the transfers with another tracked wallet (a transaction of another protocol).
    TrackedWalletsOnly,
}

/// One transfer between two owners.
#[derive(Clone, Copy)]
struct Transfer {
    from: Address,
    to: Address,
    amount: i128,
}

/// The transfers of one transaction, and which of them count as capital.
struct CapitalTransfers<'a> {
    sources: TxSources<'a>,
    scope: TransferScope,
}

pub(super) fn book(
    sources: TxSources<'_>,
    scope: TransferScope,
    sheet: &mut Worksheet,
) -> Result<(), BookError> {
    let capital = CapitalTransfers { sources, scope };
    capital.book_sol(sheet)?;
    capital.book_tokens(sheet)
}

impl CapitalTransfers<'_> {
    fn book_sol(&self, sheet: &mut Worksheet) -> Result<(), BookError> {
        let TxSources {
            wallet,
            tx,
            decoded,
            ..
        } = self.sources;
        let own_accounts = wallet_token_accounts(wallet.wallet, tx);
        for (_, instruction) in decoded {
            let Some((from, to, amount)) = native_funding(instruction) else {
                continue;
            };
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
            let transfer = Transfer {
                from: account_owner(tx, from).unwrap_or(from),
                to: account_owner(tx, to).unwrap_or(to),
                amount,
            };
            self.book_transfer(sheet, Asset::Sol, transfer)?;
        }
        Ok(())
    }

    fn book_transfer(
        &self,
        sheet: &mut Worksheet,
        asset: Asset,
        transfer: Transfer,
    ) -> Result<(), BookError> {
        let wallet = self.sources.wallet;
        let Transfer { from, to, amount } = transfer;
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
        if self.scope == TransferScope::TrackedWalletsOnly && !wallet.is_tracked(other) {
            return Ok(());
        }
        let counterparty = if wallet.is_tracked(other) {
            Counterparty::TrackedWallet(other)
        } else {
            Counterparty::External {
                address: Some(other),
            }
        };
        sheet.book(asset, amount, capital(amount, counterparty))
    }

    fn book_tokens(&self, sheet: &mut Worksheet) -> Result<(), BookError> {
        let TxSources {
            wallet,
            tx,
            decoded,
            ..
        } = self.sources;
        let legs = transfers(tx, decoded);
        let mut recipients = Vec::new();
        for leg in &legs {
            let from = self.owner_before(leg.source, leg.mint);
            let to = self.owner_after(leg.destination, leg.mint);
            if let (Some(from), Some(to)) = (from, to)
                && (from != wallet.wallet || is_wallet_signer(wallet.wallet, tx))
            {
                let amount = i128::try_from(leg.amount).map_err(|_| BookError::Overflow)?;
                let transfer = Transfer { from, to, amount };
                self.book_transfer(sheet, Asset::Token { mint: leg.mint }, transfer)?;
            }
            let key = (leg.destination, leg.mint);
            if to != Some(wallet.wallet) || !self.counts(leg) || recipients.contains(&key) {
                continue;
            }
            recipients.push(key);
            self.book_receipt_fee(sheet, &legs, key)?;
        }
        Ok(())
    }

    /// Books the transfer tax withheld on the wallet's receipts into the account and mint `key`.
    /// In another protocol's transaction, only the tax on tracked-wallet receipts is the
    /// transfer's: the rest of the account's tax belongs to the protocol's own legs.
    fn book_receipt_fee(
        &self,
        sheet: &mut Worksheet,
        legs: &[TransferLeg],
        key: (Address, Address),
    ) -> Result<(), BookError> {
        let TxSources { tx, decoded, .. } = self.sources;
        let into_account = legs.iter().filter(|leg| (leg.destination, leg.mint) == key);
        let explicit = into_account
            .clone()
            .filter(|leg| self.counts(leg))
            .try_fold(0_u128, |total, leg| {
                total.checked_add(leg.fee).ok_or(BookError::Overflow)
            })?;
        let fee = if into_account.clone().all(|leg| self.counts(leg)) {
            received_fee(tx, decoded, legs, key)?.unwrap_or(explicit)
        } else {
            explicit
        };
        let (_, mint) = key;
        sheet.book(
            Asset::Token { mint },
            i128::try_from(fee)
                .map_err(|_| BookError::Overflow)?
                .checked_neg()
                .ok_or(BookError::Overflow)?,
            EntryKind::TransferFee,
        )
    }

    /// Whether the transfer `leg` counts as capital in this scope.
    fn counts(&self, leg: &TransferLeg) -> bool {
        self.scope == TransferScope::AnyCounterparty
            || self
                .owner_before(leg.source, leg.mint)
                .is_some_and(|from| self.sources.wallet.is_tracked(from))
    }

    /// The owner of the token account `account` of `mint` before the transaction.
    fn owner_before(&self, account: Address, mint: Address) -> Option<Address> {
        self.balance(account, mint)
            .and_then(|balance| balance.owner_pre.or(balance.owner_post))
    }

    /// The owner of the token account `account` of `mint` after the transaction.
    fn owner_after(&self, account: Address, mint: Address) -> Option<Address> {
        self.balance(account, mint)
            .and_then(|balance| balance.owner_post.or(balance.owner_pre))
    }

    fn balance(&self, account: Address, mint: Address) -> Option<&TokenBalance> {
        self.sources
            .tx
            .token_balances
            .iter()
            .find(|balance| balance.account == account && balance.mint == mint)
    }
}
