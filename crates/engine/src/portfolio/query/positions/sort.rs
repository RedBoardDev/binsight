//! How the open positions are sorted.

use std::cmp::Ordering;

use binsight_core::ratio::Percent;
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::open::RangeStatus;
use binsight_ledger::report::valued::Money;

use crate::portfolio::views::OpenPositionRow;

/// What open positions are sorted by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OpenSort {
    /// What needs attention first: out-of-range positions (longest out first), then the
    /// in-range ones closest to an edge.
    Range,
    /// Their value.
    Value,
    /// Their open PnL.
    Pnl,
    /// Their fees, claimed and unclaimed.
    Fees,
    /// Their unclaimed fees.
    Unclaimed,
    /// Their daily return.
    Dpr,
    /// How long they have been open.
    Age,
    /// Their pair, alphabetically.
    Pair,
}

/// A sort direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SortOrder {
    /// Smallest first.
    Ascending,
    /// Largest first.
    Descending,
}

impl OpenSort {
    /// The direction a sort goes in unless asked otherwise.
    pub fn natural_order(self) -> SortOrder {
        match self {
            Self::Range | Self::Pair => SortOrder::Ascending,
            _ => SortOrder::Descending,
        }
    }
}

impl SortOrder {
    /// `ordering` in this direction.
    pub(in crate::portfolio::query) fn apply(self, ordering: Ordering) -> Ordering {
        match self {
            Self::Ascending => ordering,
            Self::Descending => ordering.reverse(),
        }
    }
}

/// Orders two rows by `sort` in `order`, then by id so the order never depends on chance.
pub(super) fn compare_rows(
    left: &OpenPositionRow,
    right: &OpenPositionRow,
    sort: OpenSort,
    order: SortOrder,
) -> Ordering {
    let amount = |figure: &Figure<Money>| figure.value().map(|money| money.raw);
    let by_sort = match sort {
        OpenSort::Range => order.apply(range_key(left).cmp(&range_key(right))),
        OpenSort::Value => known_last(amount(&left.value), amount(&right.value), order),
        OpenSort::Pnl => known_last(amount(&left.pnl), amount(&right.pnl), order),
        OpenSort::Fees => known_last(amount(&left.fees), amount(&right.fees), order),
        OpenSort::Unclaimed => known_last(
            amount(&left.unclaimed_fees),
            amount(&right.unclaimed_fees),
            order,
        ),
        OpenSort::Dpr => known_last(left.dpr.value(), right.dpr.value(), order),
        OpenSort::Age => order.apply(right.opened_at.cmp(&left.opened_at)),
        OpenSort::Pair => order.apply(pair(left).cmp(&pair(right))),
    };
    by_sort.then_with(|| left.id.cmp(&right.id))
}

/// Out-of-range first, longest out first; then in range, closest to an edge first.
fn range_key(row: &OpenPositionRow) -> (u8, i128, i128) {
    if row.range.status != RangeStatus::InRange {
        let since = row
            .range
            .since
            .map_or(i128::MIN, |since| i128::from(since.as_second()));
        return (0, since, 0);
    }
    let margin = |figure: &Figure<Percent>| figure.value().map_or(i128::MAX, |percent| percent.0);
    let closest = margin(&row.range.margin_down).min(margin(&row.range.margin_up));
    (1, closest, 0)
}

/// The pair's symbols, for sorting by pair.
fn pair(row: &OpenPositionRow) -> (Option<String>, Option<String>) {
    (row.pool.base.symbol.clone(), row.pool.quote.symbol.clone())
}

/// Orders `left` and `right` by their known values; unknown values come last whatever the order.
pub(in crate::portfolio::query) fn known_last<T: Ord>(
    left: Option<T>,
    right: Option<T>,
    order: SortOrder,
) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => order.apply(left.cmp(&right)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}
