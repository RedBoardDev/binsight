//! The movements of a position, newest first, a page at a time. A page starts after the key of
//! the last movement of the previous one, so pages never overlap or skip, even when a newer
//! movement arrives in between.

use binsight_ledger::facts::{PoolFacts, PositionEventFact, PositionId};
use binsight_ledger::report::figure::{Figure, Reason};
use binsight_ledger::report::valued::{Currency, resolve, value_quote};

use crate::portfolio::query::refs::bin_price;
use crate::portfolio::read_error::ReadError;
use crate::portfolio::snapshot::Snapshot;
use crate::portfolio::views::{
    EventKey, EventPage, MovementKind, PositionEventView, RangeBounds, TokenQuantity,
};

/// The most movements one page may hold.
pub const MAX_EVENT_PAGE: usize = 200;

/// What a read of a page of movements asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventPageRequest {
    /// The position.
    pub id: PositionId,
    /// The key of the last movement already read; `None` for the newest page.
    pub after: Option<EventKey>,
    /// How many movements at most (capped at [`MAX_EVENT_PAGE`]).
    pub limit: usize,
    /// The currency of the values.
    pub currency: Currency,
}

/// A page of the movements of the position the request names, newest first.
///
/// # Errors
///
/// Returns [`ReadError::PositionNotFound`] when no tracked wallet holds or held it, and an error
/// when a value overflows.
pub fn position_events(
    snapshot: &Snapshot,
    request: EventPageRequest,
) -> Result<EventPage, ReadError> {
    let position = snapshot
        .position(request.id)
        .ok_or(ReadError::PositionNotFound(request.id))?;
    let pool = snapshot
        .pool(position.pool())
        .ok_or(ReadError::MissingFact)?;
    let limit = request.limit.clamp(1, MAX_EVENT_PAGE);
    let mut older = snapshot
        .events_of(request.id)
        .iter()
        .rev()
        .filter(|event| request.after.is_none_or(|after| key_of(event) < after));
    let items = older
        .by_ref()
        .take(limit)
        .map(|event| event_view(snapshot, event, pool, request.currency))
        .collect::<Result<Vec<_>, ReadError>>()?;
    let has_more = older.next().is_some();
    Ok(EventPage {
        next: items.last().filter(|_| has_more).map(|item| item.key),
        items,
    })
}

/// The place of `event` in its position's timeline.
fn key_of(event: &PositionEventFact) -> EventKey {
    EventKey {
        at: event.at,
        signature: event.signature,
        kind: MovementKind::from(&event.kind),
    }
}

/// How the timeline shows `event`.
fn event_view(
    snapshot: &Snapshot,
    event: &PositionEventFact,
    pool: &PoolFacts,
    currency: Currency,
) -> Result<PositionEventView, ReadError> {
    let flow = event.kind.flow();
    let value = match (flow, pool.quote_asset()) {
        (None, _) => None,
        (Some(_), None) => Some(Figure::unavailable(Reason::UnsupportedQuote {
            pool: pool.address,
        })),
        (Some(flow), Some(asset)) => {
            let valued = value_quote(flow.value, asset, snapshot.rates().on(event.at))?;
            Some(resolve(&valued, currency))
        }
    };
    Ok(PositionEventView {
        key: key_of(event),
        base: flow.map(|flow| TokenQuantity {
            amount: flow.base,
            decimals: pool.base.decimals,
        }),
        quote: flow.map(|flow| TokenQuantity {
            amount: flow.quote,
            decimals: pool.quote.decimals,
        }),
        value,
        price: event.active_bin_id.and_then(|bin| bin_price(pool, bin)),
        range: event.kind.range().map(|range| RangeBounds {
            lower_bin_id: range.lower_bin_id,
            upper_bin_id: range.upper_bin_id,
            lower: bin_price(pool, range.lower_bin_id),
            upper: bin_price(pool, range.upper_bin_id),
        }),
    })
}
