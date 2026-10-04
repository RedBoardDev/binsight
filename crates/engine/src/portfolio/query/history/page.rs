//! A page of History: the closed positions of the filter at one instant, sorted, read after the
//! key of the previous page's last row, with the summary of every day the page touches.
//!
//! The instant (`as_of`) is fixed by the first page and kept by the next ones, which leave out
//! later closes: the pages of one scroll never overlap or skip, and together they are exactly the
//! list of that instant. Sorting compares amounts, so it happens here, never in a client.

use std::collections::BTreeSet;

use binsight_ledger::report::period::{Window, local_day};
use jiff::Timestamp;
use jiff::civil::Date;

use super::filter::{ClosedQuery, ClosedSort};
use super::key::{compare_keys, key_of};
use crate::portfolio::query::check_scope;
use crate::portfolio::query::closed_rows::{closed_row, closed_totals};
use crate::portfolio::read_error::ReadError;
use crate::portfolio::scope::ReadContext;
use crate::portfolio::snapshot::{ClosedRow, Snapshot};
use crate::portfolio::views::{ClosedKey, ClosedPage, DayGroup};

/// The most positions one page may hold.
pub const MAX_CLOSED_PAGE: usize = 200;

/// Which page of a History list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClosedPageRequest {
    /// The instant of the list, kept from its first page; `None` for a first page (now).
    pub as_of: Option<Timestamp>,
    /// The key of the last position already read; `None` for the first page.
    pub after: Option<ClosedKey>,
    /// How many positions at most (capped at [`MAX_CLOSED_PAGE`]).
    pub limit: usize,
}

/// A page of the History list `query` asks for.
///
/// # Errors
///
/// Returns [`ReadError::WalletNotFound`] for an untracked wallet, and an error when a figure
/// overflows or the day is out of range.
pub fn closed_page(
    snapshot: &Snapshot,
    query: &ClosedQuery,
    request: ClosedPageRequest,
    context: &ReadContext,
) -> Result<ClosedPage, ReadError> {
    check_scope(snapshot, query.scope)?;
    let as_of = request.as_of.unwrap_or(context.now);
    let day = match query.day {
        Some(day) => Some(Window::of_day(day, context.now, &context.timezone)?),
        None => None,
    };
    let closed_by_then: Vec<&ClosedRow> = snapshot
        .closed_in(query.scope)
        .filter(|row| row.facts.closed_at <= as_of)
        .collect();
    let mut matched = closed_by_then
        .iter()
        .filter(|row| query.matches(snapshot, row, day.as_ref()))
        .map(|row| Ok((*row, key_of(row, query.sort, query.currency)?)))
        .collect::<Result<Vec<_>, ReadError>>()?;
    matched.sort_by(|(_, left), (_, right)| compare_keys(left, right, query.order));
    let start = request.after.map_or(0, |after| {
        matched.partition_point(|(_, key)| compare_keys(key, &after, query.order).is_le())
    });
    let limit = request.limit.clamp(1, MAX_CLOSED_PAGE);
    let page: Vec<&(&ClosedRow, ClosedKey)> = matched.iter().skip(start).take(limit).collect();
    let has_more = start.saturating_add(page.len()) < matched.len();
    let day_groups = match query.sort {
        ClosedSort::ClosedAt => Some(day_groups(&page, &matched, query, context)?),
        _ => None,
    };
    Ok(ClosedPage {
        items: page
            .iter()
            .map(|(row, _)| closed_row(snapshot, row, query.currency))
            .collect::<Result<Vec<_>, ReadError>>()?,
        next: page.last().filter(|_| has_more).map(|(_, key)| *key),
        as_of,
        matched_count: matched.len(),
        total_count: closed_by_then.len(),
        day_groups,
    })
}

/// The summary of every local day the page touches, over the whole filter (shells left out).
fn day_groups(
    page: &[&(&ClosedRow, ClosedKey)],
    matched: &[(&ClosedRow, ClosedKey)],
    query: &ClosedQuery,
    context: &ReadContext,
) -> Result<Vec<DayGroup>, ReadError> {
    let day_of = |row: &ClosedRow| local_day(row.facts.closed_at, &context.timezone);
    let mut seen: BTreeSet<Date> = BTreeSet::new();
    let days: Vec<Date> = page
        .iter()
        .map(|(row, _)| day_of(row))
        .filter(|day| seen.insert(*day))
        .collect();
    days.into_iter()
        .map(|day| {
            let rows: Vec<&ClosedRow> = matched
                .iter()
                .map(|(row, _)| *row)
                .filter(|row| day_of(row) == day && !row.valuation.is_shell)
                .collect();
            let totals = closed_totals(&rows, query.currency)?;
            Ok(DayGroup {
                day,
                count: totals.count,
                wins: totals.wins,
                losses: totals.losses,
                breakeven: totals.breakeven,
                win_rate: totals.win_rate,
                pnl: totals.pnl,
            })
        })
        .collect()
}
