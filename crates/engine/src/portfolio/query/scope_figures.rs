//! What several queries need about a scope: whether its wallet exists, how fresh its figures are,
//! and its net worth and real PnL now.

use binsight_ledger::report::figure::{Reasons, history_reasons};
use binsight_ledger::report::net_worth::NetWorth;
use binsight_ledger::report::real_pnl::{PnlPoint, PnlTimeline};
use jiff::Timestamp;

use crate::portfolio::read_error::ReadError;
use crate::portfolio::scope::Scope;
use crate::portfolio::snapshot::Snapshot;
use crate::portfolio::views::{Freshness, SyncState};

/// The net worth of `scope` now.
pub(super) fn net_worth(snapshot: &Snapshot, scope: Scope) -> Result<NetWorth, ReadError> {
    let holdings = snapshot.wallets_in(scope).map(|wallet| &wallet.holdings);
    let open: Vec<_> = snapshot.open_in(scope).map(|row| &row.valuation).collect();
    Ok(NetWorth::of(
        holdings,
        open.iter().copied(),
        snapshot.rates().spot,
    )?)
}

/// The real PnL, capital and net worth of `scope` now, from its observed `net_worth`.
pub(super) fn live_point(
    snapshot: &Snapshot,
    scope: Scope,
    net_worth: &NetWorth,
    now: Timestamp,
) -> Result<PnlPoint, ReadError> {
    let histories = snapshot.histories_in(scope);
    let timeline = PnlTimeline::new(&histories, snapshot.rates());
    Ok(timeline.live(&net_worth.total, now)?)
}

/// Checks that the wallet of `scope`, if any, is tracked.
pub(super) fn check_scope(snapshot: &Snapshot, scope: Scope) -> Result<(), ReadError> {
    match scope {
        Scope::Wallet(address) if snapshot.wallet(address).is_none() => {
            Err(ReadError::WalletNotFound(address))
        }
        _ => Ok(()),
    }
}

/// How fresh the figures of `scope` are at `now`: the worst state and largest lag of its
/// wallets.
pub(super) fn freshness(snapshot: &Snapshot, scope: Scope, now: Timestamp) -> Freshness {
    let wallets: Vec<_> = snapshot.wallets_in(scope).collect();
    Freshness {
        as_of: now,
        state: wallets
            .iter()
            .map(|wallet| wallet.sync.state)
            .max()
            .unwrap_or(SyncState::Live),
        lag_seconds: wallets
            .iter()
            .filter_map(|wallet| wallet.sync.lag_seconds)
            .max(),
    }
}

/// Why the scope does not yet cover the start of a period.
pub(super) fn incomplete_window(snapshot: &Snapshot, scope: Scope, start: Timestamp) -> Reasons {
    history_reasons(
        snapshot.wallets_in(scope).map(|wallet| &wallet.facts),
        Some(start),
    )
}
