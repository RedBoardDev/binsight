//! `GET /api/v1/positions/{position_id}/events`: a position's movements, newest first, a page at
//! a time. The cursor holds the place of the last movement read in the order the timeline is
//! sorted by, so pages never overlap or skip, even when movements share a second or a
//! transaction, or a newer one arrives in between.

use axum::Json;
use axum::extract::{Path, State};
use binsight_core::decimal::format_units;
use binsight_core::units::Decimals;
use binsight_engine::portfolio::query::{EventPageRequest, MAX_EVENT_PAGE};
use binsight_engine::portfolio::views;
use binsight_ledger::facts::{ChainOrder, EventOrder, PositionId};
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
    /// The full base token transfer, in whole tokens; `null` for lifecycle or third-mint rewards.
    pub(crate) base: Option<DecimalString>,
    /// The full quote token transfer, in whole tokens; `null` for lifecycle or third-mint rewards.
    pub(crate) quote: Option<DecimalString>,
    /// A farming reward paid in its own mint, when this movement is a reward claim.
    pub(crate) reward: Option<RewardMovement>,
    /// The accounting contribution to the header figure, converted at the position's closing
    /// or spot rate. Rebalance halves contribute only their net addition or withdrawal;
    /// base/quote retain their full transfers. Cumulative rounding by category precedes paging.
    /// `null` for lifecycle events; unavailable when a reward's own price is unknown.
    pub(crate) value: Option<Figure>,
    /// The exact bin price of its transaction; `null` when the transaction does not say it.
    pub(crate) price: Option<Price>,
    /// The range it set, when it opened or rebalanced the position.
    pub(crate) range: Option<EventRange>,
}

/// A reward claim in raw units, without assuming the token's decimals or price.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct RewardMovement {
    /// The mint paid by the pool's reward program, in base58.
    pub(crate) mint: String,
    /// A canonical integer string of raw token units, not a human token amount.
    #[schema(value_type = String, pattern = "^(0|[1-9][0-9]*)$")]
    pub(crate) raw_amount: DecimalString,
    /// Which reward program of the pool paid it.
    pub(crate) reward_index: u64,
}

/// The range a movement set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct EventRange {
    /// The lowest bin.
    pub(crate) lower_bin_id: i32,
    /// The highest bin.
    pub(crate) upper_bin_id: i32,
    /// The lower numeric displayed price; the bin ids are the pool's own. Null without a supported quote.
    pub(crate) lower: Option<Price>,
    /// The upper numeric displayed price; the bin ids are the pool's own. Null without a supported quote.
    pub(crate) upper: Option<Price>,
}

/// What the cursor of a page of movements holds: the position and the place of the last
/// movement read (block time, slot, transaction index, movement index), the order the timeline
/// is sorted by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct EventCursor {
    position: String,
    at: Timestamp,
    signature: String,
    slot: u64,
    transaction_index: u32,
    event_index: u32,
}

impl EventCursor {
    /// The cursor after `order`, in the timeline of `position`.
    fn after(position: PositionId, order: EventOrder) -> Self {
        Self {
            position: position.to_string(),
            at: order.at,
            signature: order.signature.to_string(),
            slot: order.chain.slot,
            transaction_index: order.chain.transaction_index,
            event_index: order.chain.event_index,
        }
    }

    /// The order it holds, if it belongs to the timeline of `position`.
    fn order_for(&self, position: PositionId) -> Result<EventOrder, ApiError> {
        if self.position != position.to_string() {
            return Err(foreign_cursor());
        }
        Ok(EventOrder {
            at: self.at,
            signature: self.signature.parse().map_err(|_| foreign_cursor())?,
            chain: ChainOrder {
                slot: self.slot,
                transaction_index: self.transaction_index,
                event_index: self.event_index,
            },
        })
    }
}

impl From<&views::PositionEventView> for PositionEvent {
    fn from(event: &views::PositionEventView) -> Self {
        let whole = |quantity: views::TokenQuantity| {
            DecimalString::from_canonical(format_units(quantity.amount, quantity.decimals))
        };
        Self {
            at: event.order.at,
            kind: event.kind.into(),
            signature: event.signature.to_string(),
            base: event.base.map(whole),
            quote: event.quote.map(whole),
            reward: event.reward.map(|reward| RewardMovement {
                mint: reward.mint.to_string(),
                raw_amount: DecimalString::from_canonical(format_units(
                    reward.raw_amount,
                    Decimals(0),
                )),
                reward_index: reward.reward_index,
            }),
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
        Some(text) => Some(decode_cursor::<EventCursor>(text)?.order_for(id)?),
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
            .map(|order| encode_cursor(EventCursor::after(id, order))),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use binsight_core::units::RawTokenAmount;
    use binsight_ledger::report::figure::{Figure as LedgerFigure, Reason};
    use binsight_solana::{Address, Signature};

    #[test]
    fn serializes_the_full_raw_reward_without_decimals_or_invented_pool_flows() {
        let position = PositionId {
            address: Address::from_bytes([1; 32]),
            opened_by: Signature::from_bytes([2; 64]),
        };
        let event = views::PositionEventView {
            order: EventOrder {
                chain: ChainOrder {
                    slot: 1,
                    transaction_index: 0,
                    event_index: 0,
                },
                signature: position.opened_by,
                at: Timestamp::UNIX_EPOCH,
            },
            signature: position.opened_by,
            kind: views::MovementKind::RewardClaim,
            base: None,
            quote: None,
            range: None,
            price: None,
            reward: Some(views::RewardMovement {
                mint: Address::from_bytes([9; 32]),
                raw_amount: RawTokenAmount(u128::MAX),
                reward_index: 1,
            }),
            value: Some(LedgerFigure::unavailable(Reason::UnpricedLeg { position })),
        };
        let wire = serde_json::to_value(PositionEvent::from(&event)).unwrap();
        assert_eq!(wire["kind"], "reward_claim");
        assert_eq!(wire["reward"]["raw_amount"], u128::MAX.to_string());
        assert_eq!(wire["reward"]["reward_index"], 1);
        assert!(wire["base"].is_null() && wire["quote"].is_null());
        assert_eq!(wire["value"]["exactness"], "unavailable");
    }
}
