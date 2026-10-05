//! The positions closed today and yesterday, the overview's second card.

use binsight_ledger::report::period::{Window, WindowError, local_day};
use binsight_ledger::report::valued::Currency;
use jiff::ToSpan;

use super::closed_rows::{closed_row, closed_totals};
use super::window::window_view;
use crate::portfolio::read_error::ReadError;
use crate::portfolio::scope::{ReadContext, Scope};
use crate::portfolio::snapshot::{ClosedRow, Snapshot};
use crate::portfolio::views::{ClosedDay, RECENT_CLOSES_PER_DAY, RecentClosesView};

/// The positions of `scope` closed today and yesterday, with each day's
/// totals, and the latest close of all when both days are empty.
///
/// # Errors
///
/// Returns [`ReadError::WalletNotFound`] for an untracked wallet, and an error when a figure
/// overflows.
pub fn recent_closes(
    snapshot: &Snapshot,
    scope: Scope,
    currency: Currency,
    context: &ReadContext,
) -> Result<RecentClosesView, ReadError> {
    super::check_scope(snapshot, scope)?;
    let today = local_day(context.now, &context.timezone);
    let yesterday = today.checked_sub(1.day()).map_err(|_| WindowError)?;
    let days = [today, yesterday]
        .into_iter()
        .map(|day| {
            let window = Window::of_day(day, context.now, &context.timezone)?;
            closed_day(snapshot, scope, (day, &window), currency, context)
        })
        .collect::<Result<Vec<_>, ReadError>>()?;
    let is_empty = days.iter().all(|day| day.totals.count == 0);
    let last_close = match snapshot.closed_in(scope).next() {
        Some(row) if is_empty => Some(closed_row(snapshot, row, currency)?),
        _ => None,
    };
    Ok(RecentClosesView { days, last_close })
}

/// The positions closed in the window of one day.
fn closed_day(
    snapshot: &Snapshot,
    scope: Scope,
    (day, window): (jiff::civil::Date, &Window),
    currency: Currency,
    context: &ReadContext,
) -> Result<ClosedDay, ReadError> {
    let rows: Vec<&ClosedRow> = snapshot
        .closed_in(scope)
        .filter(|row| window.contains(row.facts.closed_at))
        .collect();
    let items = rows
        .iter()
        .take(RECENT_CLOSES_PER_DAY)
        .map(|row| closed_row(snapshot, row, currency))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ClosedDay {
        day,
        window: window_view(window, context),
        totals: closed_totals(
            &rows,
            currency,
            super::scope_figures::incomplete_window(snapshot, scope, window.start),
        )?,
        remaining_count: rows.len().saturating_sub(items.len()),
        items,
    })
}
