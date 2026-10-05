//! Explain one wallet transaction as typed, conserved changes of SOL, tokens and rent.
//!
//! This module is pure. Ownership comes from the caller and on-chain facts; unexplained
//! protocol changes remain protocol income or costs, never fabricated external capital.
mod context;
mod entry;
mod fees;
mod instructions;
pub mod invariant;
mod positions;
mod real_deltas;
mod rent;
mod residue;
mod swap;
mod worksheet;
mod wsol;

pub use context::WalletContext;
pub use entry::{Asset, Counterparty, EntryKind, LedgerEntry, PositionActivitySource, RentPurpose};
pub use residue::BridgeId;

use binsight_dlmm::activity::TxActivity;
use binsight_solana::transaction::{TransactionView, TxOutcome};
use binsight_solana::{Address, programs::InstructionDecodeError};
use worksheet::Worksheet;

/// A transaction that cannot be accounted for without inventing facts.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BookError {
    /// A checked amount exceeded its integer range.
    #[error("an accounting amount overflowed")]
    Overflow,
    /// A recorded token account has no corresponding native balance.
    #[error("the token account {account} has no lamport balances")]
    TokenAccountWithoutLamports {
        /// The account.
        account: Address,
    },
    /// A known program instruction was malformed.
    #[error("an accounting instruction could not be decoded")]
    Instruction(#[from] InstructionDecodeError),
    /// A movement names an amount without a resolvable mint.
    #[error("the movement of position {position} names no mint")]
    MissingMovementMint {
        /// The position.
        position: Address,
    },
    /// Transfer tax is known in aggregate but cannot be assigned to an instruction safely.
    #[error("the transfer tax for token {mint} into {account} has uncertain provenance")]
    UncertainTransferFee {
        /// The recipient account.
        account: Address,
        /// The token mint.
        mint: Address,
    },
    /// A failed transaction changed more than its fee.
    #[error("a failed transaction leaves an unexplained change in {asset}")]
    FailedTxResidual {
        /// The asset.
        asset: Asset,
    },
    /// Entries did not add up to an observed balance change.
    #[error("the entries of {asset} do not sum to its balance change")]
    Invariant {
        /// The asset.
        asset: Asset,
    },
}

/// Books a transaction from one wallet's point of view.
///
/// Position history must keep the original [`TxActivity`] and transaction alongside these
/// entries. Deposit/withdrawal entries contain raw legs; the activity retains each rebalance's
/// kind and event instruction position. Each position entry's source indexes that original
/// activity, including a zero net deposit when a nonzero gross movement is entirely taxed.
/// Assemblers validate source index, instruction, kind and mint against the same transaction
/// bundle; entries alone cannot distinguish an unknown strategy or recover gross amounts.
///
/// # Errors
/// Returns [`BookError`] on overflow, malformed instructions, unresolved movement mints,
/// unproven transfer-tax attribution or entries inconsistent with the real balances.
/// Failed instructions are never applied.
pub fn book_transaction(
    wallet: &WalletContext,
    tx: &TransactionView,
    activity: &TxActivity,
) -> Result<Vec<LedgerEntry>, BookError> {
    let owned = wallet.owned_positions(activity);
    let deltas = real_deltas::measure(wallet.wallet, &owned, tx)?;
    let mut sheet = Worksheet::new(deltas.per_asset()?);
    if tx.outcome == TxOutcome::Succeeded {
        let instructions = instructions::decode(tx)?;
        fees::successful(wallet.wallet, tx, &instructions, &mut sheet)?;
        rent::book(
            rent::RentSources {
                wallet,
                tx,
                decoded: &instructions,
                deltas: &deltas,
            },
            &mut sheet,
        )?;
        positions::book(
            positions::PositionSources {
                wallet: wallet.wallet,
                tx,
                activity,
                owned: &owned,
                instructions: &instructions,
            },
            &mut sheet,
        )?;
        wsol::book(
            wsol::WrapSources {
                wallet: wallet.wallet,
                tx,
                decoded: &instructions,
                deltas: &deltas,
            },
            &mut sheet,
        )?;
        instructions::book_burns(&instructions, &deltas, &mut sheet)?;
        swap::book(wallet, tx, &instructions, &mut sheet)?;
        residue::book(wallet, tx, &instructions, &mut sheet)?;
    } else {
        fees::failed(wallet.wallet, tx, &mut sheet)?;
        if let Some((asset, _)) = sheet.residues().first() {
            return Err(BookError::FailedTxResidual { asset: *asset });
        }
    }
    let entries = sheet.into_entries();
    invariant::check(wallet, tx, activity, &entries)?;
    Ok(entries)
}
