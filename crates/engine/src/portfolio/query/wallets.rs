//! The tracked wallets with their net worth, real PnL and counts.

use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::open::RangeStatus;
use binsight_ledger::report::valued::{Currency, Valued, percent_of, resolve};

use super::scope_figures::{live_point, net_worth};
use crate::portfolio::read_error::ReadError;
use crate::portfolio::scope::{ReadContext, Scope};
use crate::portfolio::snapshot::{Snapshot, TrackedWallet};
use crate::portfolio::views::{
    PositionCounts, WalletRef, WalletSummary, WalletsTotal, WalletsView,
};

/// Every tracked wallet with its figures in `currency`, and their total.
///
/// # Errors
///
/// Returns [`ReadError::Rule`] when a figure overflows.
pub fn wallets(
    snapshot: &Snapshot,
    context: &ReadContext,
    currency: Currency,
) -> Result<WalletsView, ReadError> {
    let total_worth = net_worth(snapshot, Scope::All)?;
    let total_point = live_point(snapshot, Scope::All, &total_worth, context.now)?;
    let items = snapshot
        .wallets()
        .iter()
        .map(|wallet| summary(snapshot, wallet, &total_worth.total, context, currency))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(WalletsView {
        total: WalletsTotal {
            net_worth: resolve(&total_worth.total, currency),
            real_pnl: resolve(&total_point.real_pnl, currency),
            positions: Some(counts(snapshot, Scope::All)),
        },
        items,
    })
}

/// One wallet's summary.
fn summary(
    snapshot: &Snapshot,
    wallet: &TrackedWallet,
    total_worth: &Figure<Valued>,
    context: &ReadContext,
    currency: Currency,
) -> Result<WalletSummary, ReadError> {
    let scope = Scope::Wallet(wallet.facts.address);
    let worth = net_worth(snapshot, scope)?;
    let point = live_point(snapshot, scope, &worth, context.now)?;
    Ok(WalletSummary {
        wallet: WalletRef {
            address: wallet.facts.address,
            label: wallet.label.clone(),
            color: wallet.color,
        },
        added_at: wallet.facts.added_at,
        sync: wallet.sync.clone(),
        share_of_net_worth: percent_of(&worth.total, total_worth, currency)?,
        net_worth: resolve(&worth.total, currency),
        real_pnl: resolve(&point.real_pnl, currency),
        positions: Some(counts(snapshot, scope)),
    })
}

/// Counts the open, out-of-range and closed positions of `scope`.
fn counts(snapshot: &Snapshot, scope: Scope) -> PositionCounts {
    let open: Vec<_> = snapshot.open_in(scope).collect();
    PositionCounts {
        out_of_range: open
            .iter()
            .filter(|row| row.valuation.range != RangeStatus::InRange)
            .count(),
        open: open.len(),
        closed: snapshot.closed_in(scope).count(),
    }
}
