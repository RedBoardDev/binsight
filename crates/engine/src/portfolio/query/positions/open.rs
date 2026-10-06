//! The open positions of a scope: rows with their range, bins and figures, sorted, and totals.

use std::collections::{BTreeMap, BTreeSet};

use binsight_core::ratio::Percent;
use binsight_ledger::report::figure::{Figure, Reason};
use binsight_ledger::report::open::{RangeStatus, range_margins};
use binsight_ledger::report::returns::{annual_return, daily_return};
use binsight_ledger::report::valued::{Currency, Valued, percent_of, resolve, sum_valued};
use binsight_solana::Address;

use super::bin_chart::bin_chart;
use super::sort::{OpenSort, SortOrder, compare_rows};
use crate::portfolio::query::refs::{bin_price, pool_ref, range_prices, wallet_ref};
use crate::portfolio::query::scope_figures::net_worth;
use crate::portfolio::read_error::ReadError;
use crate::portfolio::scope::{ReadContext, Scope};
use crate::portfolio::snapshot::{OpenRow, Snapshot};
use crate::portfolio::views::{
    OpenPositionRow, OpenPositionsView, OpenTotals, PriceView, RangeView,
};

/// What a read of the open positions asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenPositionsRequest {
    /// Whose positions.
    pub scope: Scope,
    /// How to sort them.
    pub sort: OpenSort,
    /// In which direction; `None` for the sort's natural one.
    pub order: Option<SortOrder>,
    /// The currency of the figures.
    pub currency: Currency,
}

/// The open positions of the request's scope, sorted, with their totals.
///
/// # Errors
///
/// Returns [`ReadError::WalletNotFound`] for an untracked wallet, and an error when a figure
/// overflows.
pub fn open_positions(
    snapshot: &Snapshot,
    request: OpenPositionsRequest,
    context: &ReadContext,
) -> Result<OpenPositionsView, ReadError> {
    crate::portfolio::query::check_scope(snapshot, request.scope)?;
    let rows: Vec<&OpenRow> = snapshot.open_in(request.scope).collect();
    let wallet_worth = rows
        .iter()
        .map(|row| row.facts.wallet)
        .collect::<BTreeSet<Address>>()
        .into_iter()
        .map(|wallet| Ok((wallet, net_worth(snapshot, Scope::Wallet(wallet))?.total)))
        .collect::<Result<BTreeMap<_, _>, ReadError>>()?;
    let mut items = rows
        .iter()
        .map(|row| {
            let worth = wallet_worth
                .get(&row.facts.wallet)
                .ok_or(ReadError::MissingFact)?;
            open_row(snapshot, row, worth, request.currency, context)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let order = request
        .order
        .unwrap_or_else(|| request.sort.natural_order());
    items.sort_by(|left, right| compare_rows(left, right, request.sort, order));
    Ok(OpenPositionsView {
        items,
        freshness: crate::portfolio::query::freshness(snapshot, request.scope, context.now),
        totals: open_totals(&rows, request.currency)?,
    })
}

/// The row of one open position, whose wallet is worth `wallet_worth`.
pub(super) fn open_row(
    snapshot: &Snapshot,
    row: &OpenRow,
    wallet_worth: &Figure<Valued>,
    currency: Currency,
    context: &ReadContext,
) -> Result<OpenPositionRow, ReadError> {
    let (facts, valuation) = (&row.facts, &row.valuation);
    let pool = snapshot.pool(facts.pool).ok_or(ReadError::MissingFact)?;
    let price = bin_price(pool, facts.active_bin_id);
    let (lower, upper) = range_prices(pool, facts.lower_bin_id, facts.upper_bin_id);
    let held = context.now.duration_since(facts.opened_at).as_secs();
    let (margin_down, margin_up) = margins(price, lower, upper, facts.pool);
    Ok(OpenPositionRow {
        id: facts.id,
        wallet: wallet_ref(snapshot, facts.wallet)?,
        pool: pool_ref(snapshot, facts.pool)?,
        strategy: facts.strategy,
        opened_at: facts.opened_at,
        price,
        lower,
        upper,
        range: RangeView {
            status: valuation.range,
            since: facts.range_since,
            margin_down,
            margin_up,
            composition: valuation.composition,
        },
        bins: bin_chart(facts, pool)?,
        value: resolve(&valuation.value, currency),
        invested: resolve(&valuation.invested, currency),
        withdrawn: resolve(&valuation.withdrawn, currency),
        net_invested: resolve(&valuation.net_invested, currency),
        claimed_fees: resolve(&valuation.claimed_fees, currency),
        rewards: resolve(&valuation.rewards, currency),
        unclaimed_fees: resolve(&valuation.unclaimed_fees, currency),
        fees: resolve(&valuation.fees, currency),
        pnl: resolve(&valuation.pnl, currency),
        pnl_pct: percent_of(&valuation.pnl, &valuation.invested, currency)?,
        dpr: daily_return(&valuation.pnl, &valuation.invested, held, currency)?,
        apr: annual_return(&valuation.pnl, &valuation.invested, held, currency)?,
        share_of_net_worth: percent_of(&valuation.value, wallet_worth, currency)?,
    })
}

/// The margins of a range, unavailable when the pool's prices are unknown.
fn margins(
    price: Option<PriceView>,
    lower: Option<PriceView>,
    upper: Option<PriceView>,
    pool: Address,
) -> (Figure<Percent>, Figure<Percent>) {
    let unavailable = || Figure::unavailable(Reason::UnsupportedQuote { pool });
    let (Some(price), Some(lower), Some(upper)) = (price, lower, upper) else {
        return (unavailable(), unavailable());
    };
    match range_margins(price.value, lower.value, upper.value) {
        Ok((down, up)) => (Figure::Complete(down), Figure::Complete(up)),
        Err(_) => (
            Figure::unavailable(Reason::ZeroDenominator),
            Figure::unavailable(Reason::ZeroDenominator),
        ),
    }
}

/// The totals of open positions.
fn open_totals(rows: &[&OpenRow], currency: Currency) -> Result<OpenTotals, ReadError> {
    let sum = |field: fn(&OpenRow) -> &Figure<Valued>| {
        sum_valued(rows.iter().map(|row| field(row).clone()))
    };
    let net_invested = sum(|row| &row.valuation.net_invested)?;
    let pnl = sum(|row| &row.valuation.pnl)?;
    Ok(OpenTotals {
        count: rows.len(),
        out_of_range_count: rows
            .iter()
            .filter(|row| row.valuation.range != RangeStatus::InRange)
            .count(),
        value: resolve(&sum(|row| &row.valuation.value)?, currency),
        invested: resolve(&sum(|row| &row.valuation.invested)?, currency),
        withdrawn: resolve(&sum(|row| &row.valuation.withdrawn)?, currency),
        claimed_fees: resolve(&sum(|row| &row.valuation.claimed_fees)?, currency),
        rewards: resolve(&sum(|row| &row.valuation.rewards)?, currency),
        unclaimed_fees: resolve(&sum(|row| &row.valuation.unclaimed_fees)?, currency),
        fees: resolve(&sum(|row| &row.valuation.fees)?, currency),
        pnl_pct: percent_of(&pnl, &net_invested, currency)?,
        net_invested: resolve(&net_invested, currency),
        pnl: resolve(&pnl, currency),
    })
}
