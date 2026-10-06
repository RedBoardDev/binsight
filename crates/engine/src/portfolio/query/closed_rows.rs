//! Closed positions as rows and totals, in the currency of the read.

use binsight_ledger::facts::PnlMethod;
use binsight_ledger::report::closed_totals::ClosedTotals;
use binsight_ledger::report::figure::Reasons;
use binsight_ledger::report::valued::{Currency, resolve};

use super::refs::{pool_ref, wallet_ref};
use crate::portfolio::read_error::ReadError;
use crate::portfolio::snapshot::{ClosedRow, Snapshot};
use crate::portfolio::views::{ClosedPositionRow, ClosedTotalsView, PnlMethodView};

/// The row of a closed position.
pub(super) fn closed_row(
    snapshot: &Snapshot,
    row: &ClosedRow,
    currency: Currency,
) -> Result<ClosedPositionRow, ReadError> {
    let (facts, valuation) = (&row.facts, &row.valuation);
    Ok(ClosedPositionRow {
        id: facts.id,
        wallet: wallet_ref(snapshot, facts.wallet)?,
        pool: pool_ref(snapshot, facts.pool)?,
        strategy: facts.strategy,
        opened_at: facts.opened_at,
        closed_at: facts.closed_at,
        held_seconds: valuation.held_seconds,
        invested: resolve(&valuation.invested, currency),
        withdrawn: resolve(&valuation.withdrawn, currency),
        fees: resolve(&valuation.claimed_fees, currency),
        rewards: resolve(&valuation.rewards, currency),
        fees_pct: row.returns(currency).fees_percent.clone(),
        pnl: resolve(&valuation.pnl, currency),
        pnl_pct: row.returns(currency).pnl_percent.clone(),
        lp_pnl: resolve(&valuation.lp_pnl, currency),
        market_pnl: valuation
            .market_pnl
            .as_ref()
            .map(|market| resolve(market, currency)),
        method: match facts.method {
            PnlMethod::Fifo { .. } => PnlMethodView::Fifo,
            PnlMethod::Pool => PnlMethodView::Pool,
        },
        outcome: valuation.outcome,
        dpr: row.returns(currency).daily_return.clone(),
        is_shell: valuation.is_shell,
    })
}

/// The totals of `rows`, in `currency`.
pub(super) fn closed_totals(
    rows: &[&ClosedRow],
    currency: Currency,
    incomplete: Reasons,
) -> Result<ClosedTotalsView, ReadError> {
    let totals = ClosedTotals::of(rows.iter().map(|row| &row.valuation))?.with_history(incomplete);
    Ok(ClosedTotalsView {
        count: totals.count,
        wins: totals.wins,
        losses: totals.losses,
        flat: totals.flat,
        unclassified_count: totals.unknown,
        pnl_pct: totals.pnl_percent(currency)?,
        win_rate: totals.win_rate,
        pnl: resolve(&totals.pnl, currency),
        fees: resolve(&totals.fees, currency),
        rewards: resolve(&totals.rewards, currency),
        invested: resolve(&totals.invested, currency),
        withdrawn: resolve(&totals.withdrawn, currency),
        average_held_seconds: totals.average_held_seconds,
        median_held_seconds: totals.median_held_seconds,
    })
}
