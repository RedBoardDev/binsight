//! The overview: today's closes, the net worth in its parts, the open positions together, the
//! gain over the period and what deserves attention.

mod watch;

use binsight_ledger::report::open::RangeStatus;
use binsight_ledger::report::period::{Period, Window};
use binsight_ledger::report::real_pnl::PnlTimeline;
use binsight_ledger::report::valued::{Currency, percent_of, resolve, sum_valued};
use binsight_solana::Address;

use super::closed_rows::closed_totals;
use super::refs::{token_ref, wallet_ref};
use super::scope_figures::{freshness, live_point, net_worth};
use super::window::{period_window, window_view};
use crate::portfolio::instance_status::InstanceStatus;
use crate::portfolio::read_error::ReadError;
use crate::portfolio::scope::{ReadContext, Scope};
use crate::portfolio::snapshot::{ClosedRow, OpenRow, Snapshot};
use crate::portfolio::views::{
    GainView, NetWorthView, OpenSummary, OverviewSync, OverviewView, SyncState, TodayView,
    UnpricedHolding,
};

/// What an overview read asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverviewRequest {
    /// Whose figures.
    pub scope: Scope,
    /// The period of the gain.
    pub period: Period,
    /// The currency of the figures.
    pub currency: Currency,
}

/// The overview of the request's scope.
///
/// # Errors
///
/// Returns [`ReadError::WalletNotFound`] for an untracked wallet, and an error when a figure
/// overflows.
pub fn overview(
    snapshot: &Snapshot,
    status: &InstanceStatus,
    request: OverviewRequest,
    context: &ReadContext,
) -> Result<OverviewView, ReadError> {
    super::check_scope(snapshot, request.scope)?;
    let (scope, currency) = (request.scope, request.currency);
    let worth = net_worth(snapshot, scope)?;
    let live = live_point(snapshot, scope, &worth, context.now)?;
    let histories = snapshot.histories_in(scope);
    let timeline = PnlTimeline::new(&histories, snapshot.rates());
    let window = period_window(snapshot, scope, request.period, context)?;
    let (gain, gain_percent) = timeline.gain(&window, &live, currency)?;
    let unpriced = unpriced_holdings(snapshot, scope)?;
    Ok(OverviewView {
        wallet: match scope {
            Scope::All => None,
            Scope::Wallet(address) => Some(wallet_ref(snapshot, address)?),
        },
        freshness: freshness(snapshot, scope, context.now),
        sync: overview_sync(snapshot, scope),
        today: today(snapshot, scope, currency, context)?,
        open: open_summary(snapshot, scope, currency)?,
        gain: GainView {
            window: window_view(&window, context),
            value: resolve(&gain, currency),
            pct: gain_percent,
        },
        watch: watch::watch_items(snapshot, status, scope, &unpriced, context.now)?,
        net_worth: NetWorthView {
            total: resolve(&worth.total, currency),
            idle: resolve(&worth.idle, currency),
            lp: resolve(&worth.lp, currency),
            unclaimed_fees: resolve(&worth.unclaimed_fees, currency),
            recoverable_rent: resolve(&worth.recoverable_rent, currency),
            unpriced,
        },
    })
}

/// The positions closed since local midnight.
fn today(
    snapshot: &Snapshot,
    scope: Scope,
    currency: Currency,
    context: &ReadContext,
) -> Result<TodayView, ReadError> {
    let window = Window::of_period(Period::Today, context.now, &context.timezone, None)?;
    let rows: Vec<&ClosedRow> = snapshot
        .closed_in(scope)
        .filter(|row| window.contains(row.facts.closed_at))
        .collect();
    Ok(TodayView {
        window: window_view(&window, context),
        totals: closed_totals(
            &rows,
            currency,
            super::scope_figures::incomplete_window(snapshot, scope, window.start),
        )?,
    })
}

/// The open positions of the scope together.
fn open_summary(
    snapshot: &Snapshot,
    scope: Scope,
    currency: Currency,
) -> Result<OpenSummary, ReadError> {
    let rows: Vec<&OpenRow> = snapshot.open_in(scope).collect();
    let pnl = sum_valued(rows.iter().map(|row| row.valuation.pnl.clone()))?;
    let net_invested = sum_valued(rows.iter().map(|row| row.valuation.net_invested.clone()))?;
    let unclaimed = sum_valued(rows.iter().map(|row| row.valuation.unclaimed_fees.clone()))?;
    Ok(OpenSummary {
        count: rows.len(),
        out_of_range_count: rows
            .iter()
            .filter(|row| row.valuation.range != RangeStatus::InRange)
            .count(),
        pnl_pct: percent_of(&pnl, &net_invested, currency)?,
        pnl: resolve(&pnl, currency),
        unclaimed_fees: resolve(&unclaimed, currency),
        unclaimed_position_count: rows
            .iter()
            .filter(|row| row.facts.unclaimed_fees.0 > 0)
            .count(),
    })
}

/// Which wallets of the scope lag or import their history.
fn overview_sync(snapshot: &Snapshot, scope: Scope) -> OverviewSync {
    let wallets: Vec<_> = snapshot.wallets_in(scope).collect();
    let refs = |state: SyncState| -> Vec<Address> {
        wallets
            .iter()
            .filter(|wallet| wallet.sync.state == state)
            .map(|wallet| wallet.facts.address)
            .collect()
    };
    OverviewSync {
        state: wallets
            .iter()
            .map(|wallet| wallet.sync.state)
            .max()
            .unwrap_or(SyncState::Live),
        lagging: refs(SyncState::Lagging)
            .into_iter()
            .filter_map(|address| snapshot.wallet_ref(address))
            .collect(),
        importing: wallets
            .iter()
            .filter_map(|wallet| {
                let progress = wallet.sync.import?.progress;
                Some((snapshot.wallet_ref(wallet.facts.address)?, progress))
            })
            .collect(),
    }
}

/// The tokens the scope holds without a price.
fn unpriced_holdings(snapshot: &Snapshot, scope: Scope) -> Result<Vec<UnpricedHolding>, ReadError> {
    snapshot
        .wallets_in(scope)
        .flat_map(|wallet| {
            wallet.holdings.unpriced.iter().map(move |token| {
                let facts = snapshot.token(token.mint).ok_or(ReadError::MissingFact)?;
                Ok(UnpricedHolding {
                    wallet: wallet_ref(snapshot, wallet.facts.address)?,
                    token: token_ref(snapshot, facts),
                    amount: token.amount,
                })
            })
        })
        .collect()
}
