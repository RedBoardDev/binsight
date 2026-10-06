//! Authenticated position share cards project the existing detail read. Figures and metadata
//! retain their source quality, and holding time comes from the same engine read instant.

use axum::Json;
use axum::extract::{Path, State};
use binsight_engine::portfolio::query::PositionRequest;
use binsight_engine::portfolio::views;
use jiff::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

use super::position_id::parse_position_id;
use crate::app::AppState;
use crate::contract::{
    ApiQuery, BinChart, ClosedPositionRow, CurrencyQuery, Figure, OpenMethod, OpenPositionRow,
    PercentFigure, PnlMethod, PoolRef, RangeInfo, Strategy, WalletRef,
};
use crate::error::{ApiError, ErrorBody};

/// A share card's figures are those of its open or closed position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum PositionShareCard {
    /// A currently open position, with its liquidity range and bins.
    Open(Box<OpenPositionShareCard>),
    /// A closed position, with its final holding time and closing instant.
    Closed(Box<ClosedPositionShareCard>),
}

/// The PnL of an open position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpenSharePnlKind {
    /// Open position PnL, including its current liquidity and claimable fees.
    Open,
}

/// The PnL of a closed position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClosedSharePnlKind {
    /// The final position PnL, measured by the detail's pool or FIFO method.
    Realized,
}

/// The data to render an open position's card; rendering remains a client operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OpenPositionShareCard {
    /// The stable full position identity, including its opening signature.
    pub(crate) id: String,
    /// Its physical account address.
    pub(crate) address: String,
    /// Its pool, including the existing token logo references.
    pub(crate) pool: PoolRef,
    /// The owner wallet reference.
    pub(crate) wallet: WalletRef,
    /// Its proven strategy, or explicit `null` when unknown.
    #[schema(required = true)]
    pub(crate) strategy: Option<Strategy>,
    /// Its open PnL, preserving exactness and reasons.
    pub(crate) pnl: Figure,
    /// The meaning of this card's PnL.
    pub(crate) pnl_kind: OpenSharePnlKind,
    /// Its PnL percentage from the detail read.
    pub(crate) pnl_pct: PercentFigure,
    /// Open positions are valued at their pool's bins.
    pub(crate) method: OpenMethod,
    /// When it opened.
    pub(crate) opened_at: Timestamp,
    /// Explicit `null`: this position has not closed.
    #[schema(required = true)]
    pub(crate) closed_at: Option<Timestamp>,
    /// Seconds held at the engine's shared financial read instant.
    pub(crate) held_seconds: i64,
    /// What was invested, unchanged from the detail.
    pub(crate) invested: Figure,
    /// Claimed and unclaimed swap fees, unchanged from the detail.
    pub(crate) fees: Figure,
    /// Its existing grouped liquidity bins.
    pub(crate) bins: BinChart,
    /// Its existing range and composition.
    pub(crate) range: RangeInfo,
}

/// The data to render a closed position's card; it has no current range or bins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ClosedPositionShareCard {
    /// The stable full position identity, including its opening signature.
    pub(crate) id: String,
    /// Its physical account address, which may have hosted other lives.
    pub(crate) address: String,
    /// Its pool, including the existing token logo references.
    pub(crate) pool: PoolRef,
    /// The owner wallet reference.
    pub(crate) wallet: WalletRef,
    /// Its proven strategy, or explicit `null` when unknown.
    #[schema(required = true)]
    pub(crate) strategy: Option<Strategy>,
    /// Its final PnL, preserving exactness and reasons.
    pub(crate) pnl: Figure,
    /// The meaning of this card's PnL.
    pub(crate) pnl_kind: ClosedSharePnlKind,
    /// Its PnL percentage from the detail read.
    pub(crate) pnl_pct: PercentFigure,
    /// The same pool or FIFO method as the closed detail.
    pub(crate) method: PnlMethod,
    /// When it opened.
    pub(crate) opened_at: Timestamp,
    /// When it closed.
    pub(crate) closed_at: Timestamp,
    /// Seconds between its opening and closing, from the engine row.
    pub(crate) held_seconds: i64,
    /// What was invested, unchanged from the detail.
    pub(crate) invested: Figure,
    /// Claimed swap fees, unchanged from the detail.
    pub(crate) fees: Figure,
    /// Explicit `null`: closed liquidity has no current bins.
    #[schema(required = true)]
    pub(crate) bins: Option<BinChart>,
    /// Explicit `null`: closed liquidity has no current range.
    #[schema(required = true)]
    pub(crate) range: Option<RangeInfo>,
}

impl From<views::PositionDetailView> for PositionShareCard {
    fn from(view: views::PositionDetailView) -> Self {
        match view.position {
            views::PositionState::Open { row, .. } => {
                let held_seconds = row.held_seconds;
                let row = OpenPositionRow::from(row.as_ref());
                Self::Open(Box::new(OpenPositionShareCard {
                    id: row.id,
                    address: row.address,
                    pool: row.pool,
                    wallet: row.wallet,
                    strategy: row.strategy,
                    pnl: row.pnl,
                    pnl_kind: OpenSharePnlKind::Open,
                    pnl_pct: row.pnl_pct,
                    method: row.method,
                    opened_at: row.opened_at,
                    closed_at: None,
                    held_seconds,
                    invested: row.invested,
                    fees: row.fees,
                    bins: row.bins,
                    range: row.range,
                }))
            }
            views::PositionState::Closed(row) => {
                let row = ClosedPositionRow::from(row.as_ref());
                Self::Closed(Box::new(ClosedPositionShareCard {
                    id: row.id,
                    address: row.address,
                    pool: row.pool,
                    wallet: row.wallet,
                    strategy: row.strategy,
                    pnl: row.pnl,
                    pnl_kind: ClosedSharePnlKind::Realized,
                    pnl_pct: row.pnl_pct,
                    method: row.method,
                    opened_at: row.opened_at,
                    closed_at: row.closed_at,
                    held_seconds: row.held_seconds,
                    invested: row.invested,
                    fees: row.fees,
                    bins: None,
                    range: None,
                }))
            }
        }
    }
}

/// Reads the existing position detail once and projects it into a client-rendered share card.
#[utoipa::path(
    get,
    path = "/api/v1/share/positions/{position_id}",
    operation_id = "getPositionShareCard",
    tag = "share",
    security(("session_cookie" = [])),
    params(
        ("position_id" = String, Path, description = "The full permanent id: `<address>-<opening signature>`, both in base58."),
        CurrencyQuery,
    ),
    responses(
        (status = 200, description = "The position card's data. Rendering is performed by the client.", body = PositionShareCard),
        (status = 400, description = "The id or currency is invalid (`invalid_request`).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 404, description = "No tracked wallet holds or held this position (`position_not_found`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn get_position_share_card(
    State(state): State<AppState>,
    Path(position_id): Path<String>,
    ApiQuery(currency): ApiQuery<CurrencyQuery>,
) -> Result<Json<PositionShareCard>, ApiError> {
    let request = PositionRequest {
        id: parse_position_id(&position_id)?,
        currency: currency.currency(),
    };
    let position = state.engine.read_model().position(request).await?;
    Ok(Json(position.into()))
}

#[cfg(test)]
mod tests {
    use binsight_demo::{DemoPortfolio, WorldSpec};
    use binsight_engine::portfolio::query::{OpenPositionsRequest, OpenSort};
    use binsight_engine::portfolio::{PortfolioReads, PositionReads, Scope};
    use binsight_ledger::report::figure::{Figure as SourceFigure, Reason};
    use binsight_ledger::report::valued::Currency;
    use jiff::tz::TimeZone;

    use super::*;

    #[tokio::test]
    async fn preserves_unavailable_source_figures_without_zero_or_value_fallbacks() {
        let anchor = Timestamp::from_second(1_790_000_000).unwrap();
        let portfolio = DemoPortfolio::new(&WorldSpec::new(anchor, TimeZone::UTC)).unwrap();
        let open = portfolio
            .open_positions(OpenPositionsRequest {
                scope: Scope::All,
                sort: OpenSort::Range,
                order: None,
                currency: Currency::Usd,
            })
            .await
            .unwrap();
        let mut view = portfolio
            .position(PositionRequest {
                id: open.items.first().unwrap().id,
                currency: Currency::Usd,
            })
            .await
            .unwrap();
        let views::PositionState::Open { row, .. } = &mut view.position else {
            panic!("the chosen source position is open");
        };
        row.pnl = SourceFigure::unavailable(Reason::NoUsdRate);
        row.pnl_pct = SourceFigure::unavailable(Reason::NoUsdRate);
        row.invested = SourceFigure::unavailable(Reason::NoUsdRate);
        row.fees = SourceFigure::unavailable(Reason::NoUsdRate);
        row.strategy = None;
        let card = serde_json::to_value(PositionShareCard::from(view)).unwrap();
        assert!(card.get("strategy").unwrap().is_null());
        for field in ["pnl", "pnl_pct", "invested", "fees"] {
            let figure = card.get(field).unwrap();
            assert_eq!(figure.get("exactness").unwrap(), "unavailable");
            assert!(figure.get("value").is_none());
            assert_eq!(
                figure.get("reasons").unwrap(),
                &serde_json::json!([{ "code": "no_usd_rate" }])
            );
        }
    }
}
