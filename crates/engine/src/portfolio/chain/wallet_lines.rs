//! What the engine knows of each tracked wallet, as the sync lines and wallet rows the API shows.
//!
//! The engine knows a wallet's ingestion (how much is listed and fetched, its sync state) but
//! does not compute its figures yet: they are unavailable, a wallet still importing says so with
//! its progress, and its positions are not counted. This module is pure: the caller reads the
//! facts.

use binsight_core::ratio::Percent;
use binsight_ledger::report::figure::{Figure, Reason, Reasons};
use binsight_solana::Address;
use binsight_store::{TrackedWallet, WalletBacklog, WalletCursor, WalletListing};
use jiff::Timestamp;

use crate::portfolio::views::{
    ImportProgress, SyncState, WalletColor, WalletRef, WalletSummary, WalletSync, WalletSyncLine,
    WalletsTotal,
};
use crate::portfolio::wallet_label::WalletLabel;

/// The colors given to wallets in the order they were added, again from the first after eight.
const COLORS: [WalletColor; 8] = [
    WalletColor::Wallet1,
    WalletColor::Wallet2,
    WalletColor::Wallet3,
    WalletColor::Wallet4,
    WalletColor::Wallet5,
    WalletColor::Wallet6,
    WalletColor::Wallet7,
    WalletColor::Wallet8,
];

/// What the engine knows of one wallet.
#[derive(Debug, Clone, Copy)]
pub(super) struct WalletFacts {
    /// The wallet and its cursor.
    pub(super) wallet: TrackedWallet,
    /// Its place in the order wallets were added.
    pub(super) position: usize,
    /// Its state as the sync monitor last decided, if it did.
    pub(super) state: Option<SyncState>,
    /// What keeps its registry behind.
    pub(super) backlog: WalletBacklog,
    /// How much of its history is listed.
    pub(super) listing: WalletListing,
}

/// The sync line of a wallet at `now`.
pub(super) fn sync_line(facts: &WalletFacts, now: Timestamp) -> WalletSyncLine {
    let address = facts.wallet.address;
    let state = facts.state.unwrap_or(SyncState::Importing);
    let indexed_tx = facts.listing.listed.saturating_sub(facts.backlog.unfetched);
    let is_listed = matches!(facts.wallet.cursor, WalletCursor::HistoryComplete { .. });
    let import = (state == SyncState::Importing).then(|| ImportProgress {
        progress: is_listed
            .then(|| Percent::of(i128::from(indexed_tx), i128::from(facts.listing.listed)).ok())
            .flatten(),
        eta_seconds: None,
    });
    let lag_seconds = match state {
        SyncState::Live => Some(0),
        _ => facts
            .backlog
            .oldest_live_due_at
            .and_then(|due| u64::try_from(now.as_second().saturating_sub(due.as_second())).ok()),
    };
    WalletSyncLine {
        wallet: wallet_ref(address, facts.position),
        sync: WalletSync {
            state,
            lag_seconds,
            last_tx_at: facts.listing.newest_block_time,
            indexed_tx,
            import,
        },
    }
}

/// The row of a wallet whose figures are not computed yet.
pub(super) fn summary(line: &WalletSyncLine, added_at: Timestamp) -> WalletSummary {
    let reasons = missing_figure_reasons(line);
    WalletSummary {
        wallet: line.wallet.clone(),
        added_at,
        sync: line.sync.clone(),
        net_worth: Figure::Unavailable {
            reasons: reasons.clone(),
        },
        real_pnl: Figure::Unavailable {
            reasons: reasons.clone(),
        },
        share_of_net_worth: Figure::Unavailable { reasons },
        positions: None,
    }
}

/// The total of wallets whose figures are not computed yet.
pub(super) fn total<'a>(lines: impl IntoIterator<Item = &'a WalletSyncLine>) -> WalletsTotal {
    let reasons: Reasons = lines.into_iter().flat_map(missing_figure_reasons).collect();
    WalletsTotal {
        net_worth: Figure::Unavailable {
            reasons: reasons.clone(),
        },
        real_pnl: Figure::Unavailable { reasons },
        positions: None,
    }
}

/// Why a wallet has no figures: its import when it runs; nothing else is known to say.
fn missing_figure_reasons(line: &WalletSyncLine) -> Reasons {
    line.sync
        .import
        .map(|import| Reason::HistoryIncomplete {
            wallet: line.wallet.address,
            progress: import.progress,
        })
        .into_iter()
        .collect()
}

/// How the screens name the wallet added in `position`: its short address and its color.
fn wallet_ref(address: Address, position: usize) -> WalletRef {
    WalletRef {
        address,
        label: WalletLabel::short_address(&address),
        color: COLORS
            .get(position % COLORS.len())
            .copied()
            .unwrap_or(WalletColor::Wallet1),
    }
}

#[cfg(test)]
mod tests;
