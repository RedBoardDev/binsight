//! The immutable orders of closed positions. Only row indices are retained, rather than copies
//! of the large position ids and valuations. Currency-independent orders are shared.

use std::collections::BTreeMap;

use binsight_ledger::report::valued::Currency;

use super::ClosedRow;
use crate::portfolio::query::{ClosedSort, SortOrder, compare_keys, key_of};
use crate::portfolio::views::ClosedKey;

const SORTS: [ClosedSort; 8] = [
    ClosedSort::ClosedAt,
    ClosedSort::Held,
    ClosedSort::Invested,
    ClosedSort::Withdrawn,
    ClosedSort::Fees,
    ClosedSort::Pnl,
    ClosedSort::PnlPct,
    ClosedSort::Dpr,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ClosedIndex {
    orders: BTreeMap<(ClosedSort, Currency, SortOrder), Vec<usize>>,
}

impl ClosedIndex {
    pub(super) fn new(rows: &[ClosedRow]) -> Self {
        let mut orders = BTreeMap::new();
        for sort in SORTS {
            for currency in [Currency::Sol, Currency::Usd] {
                if currency != index_currency(sort, currency) {
                    continue;
                }
                let mut keys: Vec<_> = rows
                    .iter()
                    .enumerate()
                    .map(|(index, row)| (index, key_of(row, sort, currency)))
                    .collect();
                for order in [SortOrder::Ascending, SortOrder::Descending] {
                    keys.sort_unstable_by(|(_, left), (_, right)| compare_keys(left, right, order));
                    orders.insert(
                        (sort, currency, order),
                        keys.iter().map(|(index, _)| *index).collect(),
                    );
                }
            }
        }
        Self { orders }
    }

    pub(super) fn rows<'a>(
        &'a self,
        rows: &'a [ClosedRow],
        sort: ClosedSort,
        currency: Currency,
        order: SortOrder,
    ) -> impl Iterator<Item = (&'a ClosedRow, ClosedKey)> {
        self.orders
            .get(&(sort, index_currency(sort, currency), order))
            .into_iter()
            .flatten()
            .filter_map(move |index| rows.get(*index))
            .map(move |row| (row, key_of(row, sort, currency)))
    }
}

fn index_currency(sort: ClosedSort, currency: Currency) -> Currency {
    match sort {
        ClosedSort::ClosedAt | ClosedSort::Held => Currency::Sol,
        _ => currency,
    }
}

#[cfg(test)]
mod tests;
