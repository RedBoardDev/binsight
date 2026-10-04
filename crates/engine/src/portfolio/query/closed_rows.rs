//! Closed positions as rows and totals, in the currency of the read.

use binsight_ledger::facts::PnlMethod;
use binsight_ledger::report::closed_totals::ClosedTotals;
use binsight_ledger::report::returns::daily_return;
use binsight_ledger::report::valued::{Currency, percent_of, resolve};

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
        fees_pct: percent_of(&valuation.claimed_fees, &valuation.invested, currency)?,
        pnl: resolve(&valuation.pnl, currency),
        pnl_pct: percent_of(&valuation.pnl, &valuation.invested, currency)?,
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
        dpr: daily_return(
            &valuation.pnl,
            &valuation.invested,
            valuation.held_seconds,
            currency,
        )?,
        is_shell: valuation.is_shell,
    })
}

/// The totals of `rows`, in `currency`.
pub(super) fn closed_totals(
    rows: &[&ClosedRow],
    currency: Currency,
) -> Result<ClosedTotalsView, ReadError> {
    let totals = ClosedTotals::of(rows.iter().map(|row| &row.valuation))?;
    Ok(ClosedTotalsView {
        count: totals.count,
        wins: totals.wins,
        losses: totals.losses,
        breakeven: totals.breakeven,
        pnl_pct: totals.pnl_percent(currency)?,
        win_rate: totals.win_rate,
        pnl: resolve(&totals.pnl, currency),
        fees: resolve(&totals.fees, currency),
        invested: resolve(&totals.invested, currency),
        withdrawn: resolve(&totals.withdrawn, currency),
        average_held_seconds: totals.average_held_seconds,
        median_held_seconds: totals.median_held_seconds,
    })
}
