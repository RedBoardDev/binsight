//! The movements of a position, newest first, a page at a time. A page starts after the order of
//! the last movement of the previous one, the same order the timeline is sorted by, so pages
//! never overlap or skip, even when movements share a second or a transaction, or a newer one
//! arrives in between.

use binsight_ledger::facts::{
    EventOrder, PoolFacts, PositionEventFact, PositionEventKind, PositionId,
};
use binsight_ledger::report::figure::{Figure, Reason};
use binsight_ledger::report::movements::value_movements;
use binsight_ledger::report::valued::{Currency, Valued, resolve};

use crate::portfolio::query::refs::bin_price;
use crate::portfolio::read_error::ReadError;
use crate::portfolio::snapshot::{PositionRow, Snapshot};
use crate::portfolio::views::{
    EventPage, MovementKind, PositionEventView, RangeBounds, RewardMovement, TokenQuantity,
};

/// The most movements one page may hold.
pub const MAX_EVENT_PAGE: usize = 200;

/// What a read of a page of movements asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventPageRequest {
    /// The position.
    pub id: PositionId,
    /// The order of the last movement already read; `None` for the newest page.
    pub after: Option<EventOrder>,
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
    let events = snapshot.events_of(request.id);
    let values = match pool.quote_asset() {
        Some(asset) => {
            let rate = match position {
                PositionRow::Open(_) => snapshot
                    .rates()
                    .spot
                    .map(binsight_ledger::facts::DailyRate::Final),
                PositionRow::Closed(row) => snapshot.rates().on(row.facts.closed_at),
            };
            value_movements(events, asset, rate)?
        }
        None => events
            .iter()
            .map(|event| {
                event
                    .kind
                    .flow()
                    .is_some()
                    .then_some(())
                    .or_else(|| {
                        matches!(event.kind, PositionEventKind::RewardClaim(_)).then_some(())
                    })
                    .map(|()| Figure::unavailable(Reason::UnsupportedQuote { pool: pool.address }))
            })
            .collect(),
    };
    let mut older = events
        .iter()
        .zip(values.iter())
        .rev()
        .filter(|(event, _)| request.after.is_none_or(|after| event.sort_key() < after));
    let items = older
        .by_ref()
        .take(limit)
        .map(|(event, value)| event_view(event, value.as_ref(), pool, request.currency))
        .collect::<Vec<_>>();
    let has_more = older.next().is_some();
    Ok(EventPage {
        next: items.last().filter(|_| has_more).map(|item| item.order),
        items,
    })
}

/// How the timeline shows `event`.
fn event_view(
    event: &PositionEventFact,
    value: Option<&Figure<Valued>>,
    pool: &PoolFacts,
    currency: Currency,
) -> PositionEventView {
    let flow = event.kind.flow();
    PositionEventView {
        order: event.sort_key(),
        signature: event.signature,
        kind: MovementKind::from(&event.kind),
        base: flow.map(|flow| TokenQuantity {
            amount: flow.base,
            decimals: pool.base.decimals,
        }),
        quote: flow.map(|flow| TokenQuantity {
            amount: flow.quote,
            decimals: pool.quote.decimals,
        }),
        reward: match event.kind {
            PositionEventKind::RewardClaim(reward) => Some(RewardMovement {
                mint: reward.mint,
                raw_amount: reward.amount,
                reward_index: reward.reward_index,
            }),
            _ => None,
        },
        value: value.map(|figure| resolve(figure, currency)),
        price: event.active_bin_id.and_then(|bin| bin_price(pool, bin)),
        range: event.kind.range().map(|range| RangeBounds {
            lower_bin_id: range.lower_bin_id,
            upper_bin_id: range.upper_bin_id,
            lower: bin_price(pool, range.lower_bin_id),
            upper: bin_price(pool, range.upper_bin_id),
        }),
    }
}

#[cfg(test)]
mod tests;
