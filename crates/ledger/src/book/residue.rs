//! Classify remaining changes from direct transfers, known bridges or other protocols.
//!
//! What a transaction is follows from the programs of its top-level instructions
//! ([`TxKind`]), read once per transaction. The rules, in order:
//! 1. A transaction that calls a bridge program at top level moves capital: every remaining
//!    change is a capital deposit or withdrawal through that bridge.
//! 2. A direct transaction (only native and token programs at top level) moves capital: each
//!    transfer is booked with its counterparty.
//! 3. In a transaction of another protocol, the transfers with another tracked wallet are still
//!    capital, with that wallet as counterparty; what remains is the protocol's activity.
mod counterparty;
mod direct;

use counterparty::{account_owner, capital_counterparty, native_funding};
use direct::TransferScope;

use super::instructions::Decoded;
use super::worksheet::Worksheet;
use super::{Asset, BookError, Counterparty, EntryKind, WalletContext};
use crate::counterparties::{BridgeId, bridge_called_by};
use binsight_solana::transaction::TransactionView;
use binsight_solana::well_known::{
    ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, ED25519_PROGRAM, LIGHTHOUSE_PROGRAM,
    MEMO_PROGRAM, MEMO_V1_PROGRAM, SECP256K1_PROGRAM, SECP256R1_PROGRAM, SYSTEM_PROGRAM,
    TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
};
use binsight_solana::{Address, programs::TokenProgram};

/// What a transaction is, from the programs its top-level instructions call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TxKind {
    /// Only native and token programs: transfers between accounts.
    Direct,
    /// A bridge program is called: capital moves to or from another chain.
    Bridge(BridgeId),
    /// Another protocol, named by its first top-level program that is not native or token.
    Protocol {
        /// That program.
        root: Address,
    },
}

impl TxKind {
    /// What `tx` is.
    pub(super) fn of(tx: &TransactionView) -> Self {
        if let Some(bridge) = bridge_called_by(tx) {
            return Self::Bridge(bridge);
        }
        tx.instructions
            .iter()
            .find(|node| node.position.inner.is_none() && !is_neutral_program(node.program))
            .map_or(Self::Direct, |node| Self::Protocol { root: node.program })
    }
}

/// What the last booking steps read about the transaction.
#[derive(Clone, Copy)]
pub(super) struct TxSources<'a> {
    pub(super) wallet: &'a WalletContext,
    pub(super) tx: &'a TransactionView,
    pub(super) decoded: &'a Decoded,
    pub(super) kind: TxKind,
}

fn is_neutral_program(program: Address) -> bool {
    [
        SYSTEM_PROGRAM,
        TOKEN_PROGRAM,
        TOKEN_2022_PROGRAM,
        ASSOCIATED_TOKEN_PROGRAM,
        COMPUTE_BUDGET_PROGRAM,
        MEMO_PROGRAM,
        MEMO_V1_PROGRAM,
        LIGHTHOUSE_PROGRAM,
        ED25519_PROGRAM,
        SECP256K1_PROGRAM,
        SECP256R1_PROGRAM,
    ]
    .contains(&program)
}

/// Books the transfers between the wallet and another tracked wallet in a transaction of a
/// protocol as capital (rule 3), before swaps are looked for: a payment to another wallet of the
/// owner is never a swap leg.
pub(super) fn book_tracked_transfers(
    sources: TxSources<'_>,
    sheet: &mut Worksheet,
) -> Result<(), BookError> {
    if !matches!(sources.kind, TxKind::Protocol { .. }) {
        return Ok(());
    }
    direct::book(sources, TransferScope::TrackedWalletsOnly, sheet)
}

pub(super) fn book(sources: TxSources<'_>, sheet: &mut Worksheet) -> Result<(), BookError> {
    let TxSources {
        wallet,
        tx,
        decoded,
        kind,
    } = sources;
    if kind == TxKind::Direct {
        direct::book(sources, TransferScope::AnyCounterparty, sheet)?;
    }
    for (asset, amount) in sheet.residues() {
        let counterparty = capital_counterparty(wallet, tx, decoded, asset);
        let entry_kind = classify(sources, (asset, amount), counterparty);
        sheet.book(asset, amount, entry_kind)?;
    }
    Ok(())
}

pub(super) fn classify(
    sources: TxSources<'_>,
    change: (Asset, i128),
    counterparty: Counterparty,
) -> EntryKind {
    let TxSources { wallet, tx, .. } = sources;
    let (asset, amount) = change;
    match sources.kind {
        TxKind::Bridge(bridge) => capital(amount, Counterparty::Bridge(bridge)),
        TxKind::Protocol { root } if wallet.services.contains(&root) && amount < 0 => {
            EntryKind::ServiceFee { program: root }
        }
        TxKind::Protocol { root } => EntryKind::ProtocolActivity { program: root },
        TxKind::Direct if amount < 0 && !is_wallet_signer(wallet.wallet, tx) => {
            let program = match asset {
                Asset::Token { mint }
                    if tx.token_balances.iter().any(|balance| {
                        balance.mint == mint && balance.program == TokenProgram::Token2022
                    }) =>
                {
                    TOKEN_2022_PROGRAM
                }
                Asset::Token { .. } => TOKEN_PROGRAM,
                Asset::Sol | Asset::Rent => SYSTEM_PROGRAM,
            };
            EntryKind::ProtocolActivity { program }
        }
        TxKind::Direct => capital(amount, counterparty),
    }
}

pub(super) fn capital(amount: i128, counterparty: Counterparty) -> EntryKind {
    if amount > 0 {
        EntryKind::CapitalDeposit { counterparty }
    } else {
        EntryKind::CapitalWithdrawal { counterparty }
    }
}

fn is_wallet_signer(wallet: Address, tx: &TransactionView) -> bool {
    tx.accounts
        .iter()
        .any(|account| account.address == wallet && account.is_signer)
}
