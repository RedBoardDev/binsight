//! One position for the drawer: the same row as in its list, and its price chart. A position is
//! found by its id whatever the wallet filter, so a permanent link always opens it.

use binsight_ledger::facts::PositionId;
use binsight_ledger::report::valued::Currency;

use super::chart::chart;
use super::open::open_row;
use crate::portfolio::query::closed_rows::closed_row;
use crate::portfolio::query::{freshness, scope_figures::net_worth};
use crate::portfolio::read_error::ReadError;
use crate::portfolio::scope::{ReadContext, Scope};
use crate::portfolio::snapshot::{PositionRow, Snapshot};
use crate::portfolio::views::{PositionDetailView, PositionState};

/// What a read of one position asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PositionRequest {
    /// The position.
    pub id: PositionId,
    /// The currency of the figures.
    pub currency: Currency,
}

/// The position the request names, with its chart.
///
/// # Errors
///
/// Returns [`ReadError::PositionNotFound`] when no tracked wallet holds or held it, and an error
/// when a figure overflows.
pub fn position(
    snapshot: &Snapshot,
    request: PositionRequest,
    context: &ReadContext,
) -> Result<PositionDetailView, ReadError> {
    let found = snapshot
        .position(request.id)
        .ok_or(ReadError::PositionNotFound(request.id))?;
    let pool = snapshot.pool(found.pool()).ok_or(ReadError::MissingFact)?;
    let native_pnl = match found {
        PositionRow::Open(row) => row.valuation.native_pnl.clone(),
        PositionRow::Closed(row) => row.valuation.native_pnl.clone(),
    };
    let state = match found {
        PositionRow::Open(row) => {
            let wallet = Scope::Wallet(row.facts.wallet);
            let worth = net_worth(snapshot, wallet)?.total;
            PositionState::Open {
                row: Box::new(open_row(snapshot, row, &worth, request.currency, context)?),
                freshness: freshness(snapshot, wallet, context.now),
            }
        }
        PositionRow::Closed(row) => {
            PositionState::Closed(Box::new(closed_row(snapshot, row, request.currency)?))
        }
    };
    Ok(PositionDetailView {
        position: state,
        native_pnl,
        chart: chart(snapshot, found, pool, context.now),
    })
}

#[cfg(test)]
mod tests;
