//! The order of a History list: each position's sort value as an exact integer, then its id, so
//! the order is total and a page can start right after the key of the previous page's last row.

use std::cmp::Ordering;

use binsight_ledger::report::returns::daily_return;
use binsight_ledger::report::valued::{Currency, percent_of, resolve};

use super::filter::ClosedSort;
use crate::portfolio::query::SortOrder;
use crate::portfolio::query::positions::known_last;
use crate::portfolio::read_error::ReadError;
use crate::portfolio::snapshot::ClosedRow;
use crate::portfolio::views::ClosedKey;

/// The key of `row` for `sort`, in `currency`.
pub(super) fn key_of(
    row: &ClosedRow,
    sort: ClosedSort,
    currency: Currency,
) -> Result<ClosedKey, ReadError> {
    let (facts, valuation) = (&row.facts, &row.valuation);
    let amount = |figure| resolve(figure, currency).value().map(|money| money.raw);
    let value = match sort {
        ClosedSort::ClosedAt => Some(i128::from(facts.closed_at.as_second())),
        ClosedSort::Held => Some(i128::from(valuation.held_seconds)),
        ClosedSort::Invested => amount(&valuation.invested),
        ClosedSort::Withdrawn => amount(&valuation.withdrawn),
        ClosedSort::Fees => amount(&valuation.claimed_fees),
        ClosedSort::Pnl => amount(&valuation.pnl),
        ClosedSort::PnlPct => percent_of(&valuation.pnl, &valuation.invested, currency)?
            .value()
            .map(|percent| percent.0),
        ClosedSort::Dpr => daily_return(
            &valuation.pnl,
            &valuation.invested,
            valuation.held_seconds,
            currency,
        )?
        .value()
        .map(|percent| percent.0),
    };
    Ok(ClosedKey {
        value,
        id: facts.id,
    })
}

/// Orders two keys in `order`: by value (unknown values last whatever the order), then by id in
/// the same direction.
pub(super) fn compare_keys(left: &ClosedKey, right: &ClosedKey, order: SortOrder) -> Ordering {
    known_last(left.value, right.value, order).then_with(|| order.apply(left.id.cmp(&right.id)))
}
