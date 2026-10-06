//! Separate recoverable account rent from token value and irrecoverable bin-array costs.
//!
//! A position's rent is the wallet's only when the wallet paid it. An automation that creates
//! the wallet's position with its own lamports gets them back at the close: neither the lock nor
//! the release is the wallet's, even when the creation is not in the history.
use super::context::{OwnedPositions, RentPayer};
use super::instructions::{Decoded, decode, native_transfer};
use super::real_deltas::{RealDeltas, lamports_change};
use super::residue::{TxKind, TxSources};
use super::worksheet::Worksheet;
use super::{Asset, BookError, Counterparty, EntryKind, RentPurpose, WalletContext};
use binsight_dlmm::instruction::{bin_array_funding, position_rent_receiver};
use binsight_solana::{
    Address,
    programs::{ProgramInstruction, SystemInstruction, TokenInstruction},
    transaction::TransactionView,
};

#[derive(Clone, Copy)]
pub(super) struct RentSources<'a> {
    pub(super) wallet: &'a WalletContext,
    pub(super) tx: &'a TransactionView,
    pub(super) decoded: &'a Decoded,
    pub(super) deltas: &'a RealDeltas,
    pub(super) kind: TxKind,
}

pub(super) fn book(sources: RentSources<'_>, sheet: &mut Worksheet) -> Result<(), BookError> {
    let RentSources {
        wallet,
        tx,
        decoded,
        deltas,
        kind: tx_kind,
    } = sources;
    for rent in &deltas.rent {
        let kind = if rent.change > 0 {
            EntryKind::RentLock {
                account: rent.account,
                purpose: rent.purpose,
            }
        } else {
            EntryKind::RentRelease {
                account: rent.account,
                purpose: rent.purpose,
            }
        };
        let other = if rent.change > 0 {
            external_funder(wallet.wallet, decoded, rent.account)
        } else {
            release_destination(tx, decoded, rent.account)
                .filter(|&address| address != wallet.wallet)
        };
        if let Some(address) = other {
            let counterparty = if wallet.is_tracked(address) {
                Counterparty::TrackedWallet(address)
            } else {
                Counterparty::External {
                    address: Some(address),
                }
            };
            let late = TxSources {
                wallet,
                tx,
                decoded,
                kind: tx_kind,
            };
            // Rent another tracked wallet funded or received is capital, whatever the program.
            let capital = match counterparty {
                Counterparty::TrackedWallet(_) => {
                    super::residue::capital(rent.change, counterparty)
                }
                _ => super::residue::classify(late, (Asset::Rent, rent.change), counterparty),
            };
            sheet.book(Asset::Rent, rent.change, capital)?;
            continue;
        }
        sheet.book(Asset::Rent, rent.change, kind)?;
        sheet.book(
            Asset::Sol,
            rent.change.checked_neg().ok_or(BookError::Overflow)?,
            kind,
        )?;
    }
    let mut booked = Vec::new();
    for funding in tx.instructions.iter().filter_map(bin_array_funding) {
        if funding.funder != wallet.wallet || booked.contains(&funding.bin_array) {
            continue;
        }
        booked.push(funding.bin_array);
        let amount = lamports_change(tx, funding.bin_array);
        if amount > 0 {
            sheet.book(
                Asset::Sol,
                amount.checked_neg().ok_or(BookError::Overflow)?,
                EntryKind::RentLock {
                    account: funding.bin_array,
                    purpose: RentPurpose::BinArray,
                },
            )?;
        }
    }
    Ok(())
}

fn external_funder(wallet: Address, decoded: &Decoded, account: Address) -> Option<Address> {
    let mut funders = Vec::new();
    for (_, instruction) in decoded {
        let funder = match instruction {
            ProgramInstruction::System(
                SystemInstruction::CreateAccount {
                    funder,
                    account: created,
                    ..
                }
                | SystemInstruction::CreateAccountWithSeed {
                    funder,
                    account: created,
                    ..
                },
            ) if *created == account => Some(*funder),
            instruction => native_transfer(instruction)
                .and_then(|(from, to, amount)| (to == account && amount > 0).then_some(from)),
        };
        if let Some(funder) = funder
            && !funders.contains(&funder)
        {
            funders.push(funder);
        }
    }
    match funders.as_slice() {
        [funder] if *funder != wallet => Some(*funder),
        _ => None,
    }
}

fn release_destination(
    tx: &TransactionView,
    decoded: &Decoded,
    account: Address,
) -> Option<Address> {
    decoded
        .iter()
        .find_map(|(_, instruction)| match instruction {
            ProgramInstruction::Token {
                instruction:
                    TokenInstruction::CloseAccount {
                        account: closed,
                        destination,
                        ..
                    },
                ..
            } if *closed == account => Some(*destination),
            _ => None,
        })
        .or_else(|| {
            tx.instructions
                .iter()
                .filter_map(position_rent_receiver)
                .find_map(|(position, receiver)| (position == account).then_some(receiver))
        })
}

pub(super) fn wallet_exchange_change(
    wallet: Address,
    tx: &TransactionView,
    decoded: &Decoded,
    rent: &super::real_deltas::AccountRent,
) -> i128 {
    let is_external = if rent.change > 0 {
        external_funder(wallet, decoded, rent.account).is_some()
    } else {
        release_destination(tx, decoded, rent.account).is_some_and(|address| address != wallet)
    };
    if is_external { 0 } else { rent.change }
}

impl OwnedPositions<'_> {
    /// Whether the change `change` of the lamports of `position`, a position of the wallet, is
    /// the wallet's rent: not when another account alone funds it, nor when it is released from
    /// a position another account paid for, nor when the history does not say who paid and it
    /// goes back to another account. Rent another account paid that comes back to the wallet
    /// stays out of the rent, so the lamports the wallet receives are a gain.
    pub(super) fn holds_rent_of(
        &self,
        tx: &TransactionView,
        position: Address,
        change: i128,
    ) -> Result<bool, BookError> {
        if change == 0 {
            return Ok(true);
        }
        let wallet = self.wallet();
        let decoded = decode(tx)?;
        if change > 0 {
            return Ok(external_funder(wallet, &decoded, position).is_none());
        }
        Ok(match self.rent_payer(position) {
            Some(RentPayer::Wallet) => true,
            Some(RentPayer::Other) => false,
            None => release_destination(tx, &decoded, position).is_none_or(|to| to == wallet),
        })
    }
}
