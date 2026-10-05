//! The order of a History list: each position's sort value as an exact integer, then its id, so
//! the order is total and a page can start right after the key of the previous page's last row.

use std::cmp::Ordering;

use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::valued::{Currency, Valued};

use super::filter::ClosedSort;
use crate::portfolio::query::SortOrder;
use crate::portfolio::query::positions::known_last;
use crate::portfolio::snapshot::ClosedRow;
use crate::portfolio::views::ClosedKey;

/// The key of `row` for `sort`, in `currency`.
pub(crate) fn key_of(row: &ClosedRow, sort: ClosedSort, currency: Currency) -> ClosedKey {
    let (facts, valuation) = (&row.facts, &row.valuation);
    let amount = |figure: &Figure<Valued>| {
        figure
            .value()
            .and_then(|value| value.in_currency(currency))
            .map(|money| money.raw)
    };
    let value = match sort {
        ClosedSort::ClosedAt => Some(i128::from(facts.closed_at.as_second())),
        ClosedSort::Held => Some(i128::from(valuation.held_seconds)),
        ClosedSort::Invested => amount(&valuation.invested),
        ClosedSort::Withdrawn => amount(&valuation.withdrawn),
        ClosedSort::Fees => amount(&valuation.claimed_fees),
        ClosedSort::Pnl => amount(&valuation.pnl),
        ClosedSort::PnlPct => row
            .returns(currency)
            .pnl_percent
            .value()
            .map(|percent| percent.0),
        ClosedSort::Dpr => row
            .returns(currency)
            .daily_return
            .value()
            .map(|percent| percent.0),
    };
    ClosedKey {
        value,
        id: facts.id,
    }
}

/// Orders two keys in `order`: by value (unknown values last whatever the order), then by id in
/// the same direction.
pub(crate) fn compare_keys(left: &ClosedKey, right: &ClosedKey, order: SortOrder) -> Ordering {
    known_last(left.value, right.value, order).then_with(|| order.apply(left.id.cmp(&right.id)))
}
