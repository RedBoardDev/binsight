//! `GET /api/v1/wallets`: the tracked wallets with their net worth, real PnL and positions.

use axum::Json;
use axum::extract::State;
use binsight_engine::portfolio::views;
use jiff::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

use super::sync::WalletSync;
use crate::app::AppState;
use crate::contract::{ApiQuery, CurrencyQuery, Figure, PercentFigure, WalletRef};
use crate::error::{ApiError, ErrorBody};

/// The tracked wallets and their total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct WalletList {
    /// Each wallet, in the order they were added.
    pub(crate) items: Vec<WalletSummary>,
    /// Always `null`: the list is never paged.
    pub(crate) next_cursor: Option<String>,
    /// Every wallet together.
    pub(crate) total: WalletsTotal,
}

/// One tracked wallet and its figures.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct WalletSummary {
    /// The wallet.
    pub(crate) wallet: WalletRef,
    /// When the owner added it.
    pub(crate) added_at: Timestamp,
    /// Its synchronization (the same as in `GET /sync`).
    pub(crate) sync: WalletSync,
    /// Its net worth now.
    pub(crate) net_worth: Figure,
    /// Its real PnL since its first activity: net worth − net capital put in.
    pub(crate) real_pnl: Figure,
    /// Its net worth as a share of the total net worth.
    pub(crate) share_of_net_worth: PercentFigure,
    /// How many positions it has open.
    pub(crate) open_count: usize,
    /// How many of them are out of range.
    pub(crate) out_of_range_count: usize,
    /// How many positions it closed, empty shells left out (as History counts them).
    pub(crate) closed_count: usize,
}

/// The figures of every wallet together.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct WalletsTotal {
    /// The total net worth.
    pub(crate) net_worth: Figure,
    /// The total real PnL.
    pub(crate) real_pnl: Figure,
    /// How many positions are open.
    pub(crate) open_count: usize,
    /// How many of them are out of range.
    pub(crate) out_of_range_count: usize,
    /// How many positions were closed, empty shells left out.
    pub(crate) closed_count: usize,
}

impl From<views::WalletsView> for WalletList {
    fn from(view: views::WalletsView) -> Self {
        Self {
            items: view.items.iter().map(WalletSummary::from).collect(),
            next_cursor: None,
            total: WalletsTotal {
                net_worth: (&view.total.net_worth).into(),
                real_pnl: (&view.total.real_pnl).into(),
                open_count: view.total.open_count,
                out_of_range_count: view.total.out_of_range_count,
                closed_count: view.total.closed_count,
            },
        }
    }
}

impl From<&views::WalletSummary> for WalletSummary {
    fn from(summary: &views::WalletSummary) -> Self {
        Self {
            wallet: (&summary.wallet).into(),
            added_at: summary.added_at,
            sync: (&summary.sync).into(),
            net_worth: (&summary.net_worth).into(),
            real_pnl: (&summary.real_pnl).into(),
            share_of_net_worth: (&summary.share_of_net_worth).into(),
            open_count: summary.open_count,
            out_of_range_count: summary.out_of_range_count,
            closed_count: summary.closed_count,
        }
    }
}

/// Lists the tracked wallets with their figures.
#[utoipa::path(
    get,
    path = "/api/v1/wallets",
    operation_id = "listWallets",
    tag = "wallets",
    security(("session_cookie" = [])),
    params(CurrencyQuery),
    responses(
        (status = 200, description = "The tracked wallets and their total.", body = WalletList),
        (status = 400, description = "A query parameter is invalid (`invalid_request`).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn list_wallets(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<CurrencyQuery>,
) -> Result<Json<WalletList>, ApiError> {
    let wallets = state.engine.read_model().wallets(query.currency()).await?;
    Ok(Json(wallets.into()))
}
