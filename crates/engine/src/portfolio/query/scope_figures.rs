//! The live figures of a scope that several queries need: net worth and real PnL now.

use binsight_ledger::report::net_worth::NetWorth;
use binsight_ledger::report::real_pnl::{PnlPoint, PnlTimeline};
use jiff::Timestamp;

use crate::portfolio::read_error::ReadError;
use crate::portfolio::scope::Scope;
use crate::portfolio::snapshot::Snapshot;

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
