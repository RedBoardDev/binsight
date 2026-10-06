//! Identify exchange legs after position movements, rent, wraps, fees and tips have been removed.
//!
//! The rules, in integers:
//! 1. Only a transaction of a protocol can be a swap: never a direct transfer, a bridge or a
//!    known service.
//! 2. A token other than wrapped SOL is a leg when its net change is more than 1 % of what the
//!    wallet's accounts sent (for an outflow) or received (for an inflow) of it: a token a route
//!    passes through the wallet's account nets to almost nothing and stays out. A token no
//!    transfer moved (minted or burnt) is a leg on its net change.
//! 3. SOL is one leg, wrapped or native, never both: wrapped SOL when it was transferred from or
//!    to the wallet's accounts, native SOL otherwise. The other form stays with the protocol: a
//!    stray native change beside a wrapped-SOL swap (an unknown tip, a protocol fee), or a
//!    wrapped-SOL change no transfer made beside native proceeds (an account's rent).
//! 4. It is a swap only with at least one leg out and one leg in. Every leg of the transaction
//!    belongs to that swap; which token was sold for which is the cost-basis method's question.
//!
//! A position withdrawal is never read as a purchase: position movements are booked before this
//! step, and a withdrawal from a position the wallet does not own leaves the transaction
//! without a swap (see [`super::positions::moves_tokens_of_unowned_position`]).
use super::instructions::{Decoded, token_transfer, wallet_token_accounts};
use super::residue::{TxKind, TxSources};
use super::worksheet::Worksheet;
use super::{Asset, BookError, EntryKind};
use binsight_solana::well_known::WSOL_MINT;
use binsight_solana::{Address, transaction::TransactionView};

/// A leg must move more than this share of its gross transfers, in percent (rule 2).
const MIN_NET_PERCENT_OF_GROSS: u128 = 1;

/// Wrapped SOL, as the ledger counts it.
const WRAPPED_SOL: Asset = Asset::Token { mint: WSOL_MINT };

pub(super) fn book(sources: TxSources<'_>, sheet: &mut Worksheet) -> Result<(), BookError> {
    let TxKind::Protocol { root } = sources.kind else {
        return Ok(());
    };
    if sources.wallet.services.contains(&root) {
        return Ok(());
    }
    let transfers = WalletTransfers::of(sources);
    let residues = sheet.residues();
    let wrapped_sol_was_transferred =
        match residues.iter().find(|&&(asset, _)| asset == WRAPPED_SOL) {
            Some(&(_, amount)) => transfers.gross(WSOL_MINT, amount)? > 0,
            None => false,
        };
    let mut legs = Vec::new();
    for (asset, amount) in residues {
        let is_leg = match asset {
            Asset::Rent => false,
            Asset::Sol => !wrapped_sol_was_transferred,
            Asset::Token { mint } if mint == WSOL_MINT => wrapped_sol_was_transferred,
            Asset::Token { mint } => {
                moves_more_than_it_passes(amount, transfers.gross(mint, amount)?)?
            }
        };
        if is_leg {
            legs.push((asset, amount));
        }
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

/// The token transfers of a transaction, and the wallet's token accounts they can touch.
struct WalletTransfers<'a> {
    tx: &'a TransactionView,
    decoded: &'a Decoded,
    accounts: Vec<Address>,
}

impl<'a> WalletTransfers<'a> {
    fn of(sources: TxSources<'a>) -> Self {
        Self {
            tx: sources.tx,
            decoded: sources.decoded,
            accounts: wallet_token_accounts(sources.wallet.wallet, sources.tx),
        }
    }

    /// What the wallet's accounts sent of `mint` (when `amount`, its net change, is negative) or
    /// received of it (when it is positive), by token transfers.
    fn gross(&self, mint: Address, amount: i128) -> Result<u128, BookError> {
        let is_outflow = amount < 0;
        self.decoded
            .iter()
            .filter_map(|(_, instruction)| token_transfer(instruction, self.tx))
            .filter(|&(source, destination, token_mint, _, _)| {
                let wallet_side = if is_outflow { source } else { destination };
                token_mint == mint && self.accounts.contains(&wallet_side)
            })
            .try_fold(0_u128, |total, (_, _, _, moved, _)| {
                total.checked_add(moved).ok_or(BookError::Overflow)
            })
    }
}

/// Whether the net change `amount` is more than 1 % of the `gross` transferred in its direction
/// (rule 2); a change no transfer made counts whole.
fn moves_more_than_it_passes(amount: i128, gross: u128) -> Result<bool, BookError> {
    let net_percent = amount
        .unsigned_abs()
        .checked_mul(100)
        .ok_or(BookError::Overflow)?;
    let threshold = gross
        .checked_mul(MIN_NET_PERCENT_OF_GROSS)
        .ok_or(BookError::Overflow)?;
    Ok(gross == 0 || net_percent > threshold)
}
