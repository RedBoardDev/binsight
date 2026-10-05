//! `GET /api/v1/overview`: today's closes, the net worth in its parts, the open positions
//! together, the gain over the period and what deserves attention.

use axum::Json;
use axum::extract::State;
use binsight_engine::portfolio::query::OverviewRequest;
use binsight_engine::portfolio::views;
use serde::Serialize;
use utoipa::ToSchema;

use super::watch::{UnpricedHolding, WatchItem};
use crate::app::AppState;
use crate::contract::{
    ApiQuery, ClosedTotals, CurrencyQuery, DecimalString, Figure, Freshness, PercentFigure,
    PeriodQuery, ScopeQuery, SyncState, WalletRef, Window,
};
use crate::error::{ApiError, ErrorBody};

/// Everything the overview shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Overview {
    /// The wallet it is about; `null` for every wallet.
    pub(crate) wallet: Option<WalletRef>,
    /// How fresh its figures are.
    pub(crate) freshness: Freshness,
    /// Which wallets lag behind the chain or import their history.
    pub(crate) sync: OverviewSync,
    /// The positions closed since local midnight: the same totals as today's recent closes and
    /// History for today.
    pub(crate) today: Today,
    /// The net worth now: `total` is the sum of the four parts.
    pub(crate) net_worth: NetWorth,
    /// The open positions together.
    pub(crate) open: OpenSummary,
    /// The real PnL gained over the period.
    pub(crate) gain: Gain,
    /// What deserves attention, most urgent first.
    pub(crate) watch: Vec<WatchItem>,
}

/// The synchronization of the wallets the overview covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OverviewSync {
    /// The worst state.
    pub(crate) state: SyncState,
    /// The wallets behind the chain.
    pub(crate) lagging: Vec<WalletRef>,
    /// The wallets importing their history.
    pub(crate) importing: Vec<ImportingWallet>,
}

/// A wallet importing its history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ImportingWallet {
    /// The wallet.
    pub(crate) wallet: WalletRef,
    /// How far the import is, in percent; null when its total is unknown.
    #[schema(required = true)]
    pub(crate) progress: Option<DecimalString>,
}

/// The positions closed since local midnight.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Today {
    /// Today's window.
    pub(crate) window: Window,
    /// Their totals; `pnl_pct` is `Σ PnL / Σ invested` of today's closes.
    pub(crate) totals: ClosedTotals,
}

/// The net worth in its parts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct NetWorth {
    /// idle + lp + unclaimed fees + recoverable rent.
    pub(crate) total: Figure,
    /// Free SOL and priced tokens.
    pub(crate) idle: Figure,
    /// The liquidity in open positions.
    pub(crate) lp: Figure,
    /// The fees the open positions could claim.
    pub(crate) unclaimed_fees: Figure,
    /// The rent closing accounts would give back.
    pub(crate) recoverable_rent: Figure,
    /// The tokens held without a price, left out of the total (which is then `partial`).
    pub(crate) unpriced: Vec<UnpricedHolding>,
}

/// The open positions together.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OpenSummary {
    /// How many.
    pub(crate) count: usize,
    /// How many are out of range.
    pub(crate) out_of_range_count: usize,
    /// Their open PnL.
    pub(crate) pnl: Figure,
    /// Their PnL as a percentage of their net investment.
    pub(crate) pnl_pct: PercentFigure,
    /// The fees they could claim (the same as the net worth's part).
    pub(crate) unclaimed_fees: Figure,
    /// How many have fees to claim.
    pub(crate) unclaimed_position_count: usize,
}

/// The real PnL gained over a period.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Gain {
    /// The period's window.
    pub(crate) window: Window,
    /// Real PnL now − real PnL at the start (the real PnL series ends on it).
    pub(crate) value: Figure,
    /// The gain as a percentage of the net worth at the start; `unavailable` for `all`.
    pub(crate) pct: PercentFigure,
}

impl From<views::OverviewView> for Overview {
    fn from(view: views::OverviewView) -> Self {
        Self {
            wallet: view.wallet.as_ref().map(WalletRef::from),
            freshness: view.freshness.into(),
            sync: OverviewSync {
                state: view.sync.state.into(),
                lagging: view.sync.lagging.iter().map(WalletRef::from).collect(),
                importing: view
                    .sync
                    .importing
                    .iter()
                    .map(|(wallet, progress)| ImportingWallet {
                        wallet: wallet.into(),
                        progress: progress.map(DecimalString::from),
                    })
                    .collect(),
            },
            today: Today {
                window: (&view.today.window).into(),
                totals: (&view.today.totals).into(),
            },
            net_worth: NetWorth {
                total: (&view.net_worth.total).into(),
                idle: (&view.net_worth.idle).into(),
                lp: (&view.net_worth.lp).into(),
                unclaimed_fees: (&view.net_worth.unclaimed_fees).into(),
                recoverable_rent: (&view.net_worth.recoverable_rent).into(),
                unpriced: view
                    .net_worth
                    .unpriced
                    .iter()
                    .map(UnpricedHolding::from)
                    .collect(),
            },
            open: OpenSummary {
                count: view.open.count,
                out_of_range_count: view.open.out_of_range_count,
                pnl: (&view.open.pnl).into(),
                pnl_pct: (&view.open.pnl_pct).into(),
                unclaimed_fees: (&view.open.unclaimed_fees).into(),
                unclaimed_position_count: view.open.unclaimed_position_count,
            },
            gain: Gain {
                window: (&view.gain.window).into(),
                value: (&view.gain.value).into(),
                pct: (&view.gain.pct).into(),
            },
            watch: view.watch.iter().map(WatchItem::from).collect(),
        }
    }
}

/// Reads the overview of every wallet, or of one.
#[utoipa::path(
    get,
    path = "/api/v1/overview",
    operation_id = "getOverview",
    tag = "portfolio",
    security(("session_cookie" = [])),
    params(ScopeQuery, PeriodQuery, CurrencyQuery),
    responses(
        (status = 200, description = "The overview.", body = Overview),
        (status = 400, description = "A query parameter is invalid (`invalid_request`).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 404, description = "The wallet is not tracked (`wallet_not_found`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn get_overview(
    State(state): State<AppState>,
    ApiQuery(scope): ApiQuery<ScopeQuery>,
    ApiQuery(period): ApiQuery<PeriodQuery>,
    ApiQuery(currency): ApiQuery<CurrencyQuery>,
) -> Result<Json<Overview>, ApiError> {
    let request = OverviewRequest {
        scope: scope.scope()?,
        period: period.period(),
        currency: currency.currency(),
    };
    let overview = state.engine.read_model().overview(request).await?;
    Ok(Json(overview.into()))
}
