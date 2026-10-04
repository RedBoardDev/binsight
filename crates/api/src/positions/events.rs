//! `GET /api/v1/positions/{position_id}/events`: a position's movements, newest first, a page at
//! a time. The cursor holds the key of the last movement read, so pages never overlap or skip,
//! even when a newer movement arrives in between.

use axum::Json;
use axum::extract::{Path, State};
use binsight_core::decimal::format_units;
use binsight_engine::portfolio::query::{EventPageRequest, MAX_EVENT_PAGE};
use binsight_engine::portfolio::views;
use binsight_ledger::facts::PositionId;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::chart::MovementKind;
use super::position_id::parse_position_id;
use crate::app::AppState;
use crate::contract::{
    ApiQuery, Currency, DecimalString, Figure, Price, decode_cursor, encode_cursor, foreign_cursor,
};
use crate::error::{ApiError, ErrorBody, ErrorCode};

/// The movements a page holds unless asked otherwise.
const DEFAULT_LIMIT: usize = 50;

/// Which page of movements, in which currency.
#[derive(Debug, Clone, Default, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct EventPageQuery {
    /// The `next_cursor` of the previous page; absent for the newest movements.
    pub(crate) cursor: Option<String>,
    /// How many movements at most (50 by default, 200 at most).
    pub(crate) limit: Option<usize>,
    /// The currency of the values (`sol` by default).
    pub(crate) currency: Option<Currency>,
}

/// A page of movements, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct PositionEvents {
    /// The movements.
    pub(crate) items: Vec<PositionEvent>,
    /// The cursor of the next (older) page; `null` on the last page.
    pub(crate) next_cursor: Option<String>,
}

/// One movement of a position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct PositionEvent {
    /// When its transaction happened.
    pub(crate) at: Timestamp,
    /// What it did.
    pub(crate) kind: MovementKind,
    /// Its transaction signature (base58); several movements can share one.
    pub(crate) signature: String,
    /// The base token it moved, in whole tokens; `null` for a rebalance.
    pub(crate) base: Option<DecimalString>,
    /// The quote token it moved, in whole tokens; `null` for a rebalance.
    pub(crate) quote: Option<DecimalString>,
    /// The value of what it moved, at the bin price of its transaction and the rate of its day;
    /// `null` for a rebalance.
    pub(crate) value: Option<Figure>,
    /// The exact bin price of its transaction; `null` when the transaction does not say it.
    pub(crate) price: Option<Price>,
    /// The range it set, when it opened or rebalanced the position.
    pub(crate) range: Option<EventRange>,
}

/// The range a movement set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct EventRange {
    /// The lowest bin.
    pub(crate) lower_bin_id: i32,
    /// The highest bin.
    pub(crate) upper_bin_id: i32,
    /// The price of the lowest bin; `null` when the pool's quote cannot be valued.
    pub(crate) lower: Option<Price>,
    /// The price of the highest bin; `null` when the pool's quote cannot be valued.
    pub(crate) upper: Option<Price>,
}

/// What the cursor of a page of movements holds: the position and the last movement read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct EventCursor {
    position: String,
    at: Timestamp,
    signature: String,
    kind: MovementKind,
}

impl EventCursor {
    /// The cursor after `key`, in the timeline of `position`.
    fn after(position: PositionId, key: views::EventKey) -> Self {
        Self {
            position: position.to_string(),
            at: key.at,
            signature: key.signature.to_string(),
            kind: key.kind.into(),
        }
    }

    /// The key it holds, if it belongs to the timeline of `position`.
    fn key_for(&self, position: PositionId) -> Result<views::EventKey, ApiError> {
        if self.position != position.to_string() {
            return Err(foreign_cursor());
        }
        let signature = self.signature.parse().map_err(|_| foreign_cursor())?;
        Ok(views::EventKey {
            at: self.at,
            signature,
            kind: self.kind.into(),
        })
    }
}

impl From<&views::PositionEventView> for PositionEvent {
    fn from(event: &views::PositionEventView) -> Self {
        let whole = |quantity: views::TokenQuantity| {
            DecimalString::from_canonical(format_units(quantity.amount, quantity.decimals))
        };
        Self {
            at: event.key.at,
            kind: event.key.kind.into(),
            signature: event.key.signature.to_string(),
            base: event.base.map(whole),
            quote: event.quote.map(whole),
            value: event.value.as_ref().map(Figure::from),
            price: event.price.map(Price::from),
            range: event.range.map(|range| EventRange {
                lower_bin_id: range.lower_bin_id,
                upper_bin_id: range.upper_bin_id,
                lower: range.lower.map(Price::from),
                upper: range.upper.map(Price::from),
            }),
        }
    }
}

/// Lists a position's movements, newest first.
#[utoipa::path(
    get,
    path = "/api/v1/positions/{position_id}/events",
    operation_id = "listPositionEvents",
    tag = "positions",
    security(("session_cookie" = [])),
    params(
        ("position_id" = String, Path, description = "The position's permanent id: `<address>-<opening signature>`, both in base58."),
        EventPageQuery,
    ),
    responses(
        (status = 200, description = "A page of movements.", body = PositionEvents),
        (status = 400, description = "The id or a query parameter is invalid (`invalid_request`), or the cursor is not one of this timeline (`invalid_cursor`).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 404, description = "No tracked wallet holds or held this position (`position_not_found`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn list_position_events(
    State(state): State<AppState>,
    Path(position_id): Path<String>,
    ApiQuery(query): ApiQuery<EventPageQuery>,
) -> Result<Json<PositionEvents>, ApiError> {
    let id = parse_position_id(&position_id)?;
    let after = match query.cursor.as_deref() {
        Some(text) => Some(decode_cursor::<EventCursor>(text)?.key_for(id)?),
        None => None,
    };
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_EVENT_PAGE).contains(&limit) {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("limit: expected 1 to {MAX_EVENT_PAGE}"),
        ));
    }
    let request = EventPageRequest {
        id,
        after,
        limit,
        currency: query.currency.unwrap_or_default().into(),
    };
    let page = state.engine.read_model().position_events(request).await?;
    Ok(Json(PositionEvents {
        items: page.items.iter().map(PositionEvent::from).collect(),
        next_cursor: page
            .next
            .map(|key| encode_cursor(EventCursor::after(id, key))),
    }))
}
