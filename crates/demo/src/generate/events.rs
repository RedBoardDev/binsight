//! The movements of every position, made to add up to its figures.
//!
//! A position opens with a deposit over a range around the bin of its opening minute, sometimes
//! adds to it, claims part of its fees on the way when it lives long enough, and (once closed)
//! claims the rest and withdraws everything in its closing transaction. The deposits add up to
//! what it invested, the withdrawals to what it withdrew and the claims to its claimed fees, to
//! the unit. Each movement runs at the bin of its minute on the pool's price path, so its marker
//! falls inside its candle; its tokens are split half base, half quote at that bin's exact price.

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::math::{div_q64, mul_shr_64};
use binsight_ledger::facts::{
    BinRange, ClosedPositionFacts, OpenPositionFacts, PoolFacts, PositionEventFact,
    PositionEventKind, PositionId, QuoteUnits, TokenFlow,
};
use jiff::{SignedDuration, Timestamp};

use super::market::{PricePath, bin_price, minute_start};
use crate::addresses::signature;
use crate::error::DemoError;
use crate::random::Stream;

/// The narrowest and widest ranges of a closed position, in bins.
const WIDTH_BINS: (i64, i64) = (20, 69);

/// The share of the investment the opening deposit holds when the position adds later, in
/// percent.
const FIRST_DEPOSIT_PERCENT: i128 = 70;

/// A position adds to its liquidity one time in this many.
const ADD_ONE_IN: u64 = 3;

/// A long-lived closed position moves its range one time in this many.
const REBALANCE_ONE_IN: u64 = 4;

/// A position claims part of its fees on the way when it lives longer than this.
const MID_CLAIM_AFTER: SignedDuration = SignedDuration::from_hours(24);

/// A closed position may move its range when it lives longer than this.
const REBALANCE_AFTER: SignedDuration = SignedDuration::from_hours(72);

/// One hundred percent.
const PERCENT: i128 = 100;

/// Where a position's movements happen: its pool and the pool's price path.
#[derive(Clone, Copy)]
pub(crate) struct Market<'a> {
    /// The pool.
    pub(crate) pool: &'a PoolFacts,
    /// Its price path.
    pub(crate) path: &'a PricePath,
}

/// The movements of a closed position.
pub(crate) fn closed_events(
    seed: u64,
    position: &ClosedPositionFacts,
    market: Market<'_>,
) -> Result<Vec<PositionEventFact>, DemoError> {
    let mut stream = Stream::of(seed, &format!("events:{}", position.id));
    let mut events = Events::new(position.id, market);
    let life = position.closed_at.duration_since(position.opened_at);
    let width = stream.between(WIDTH_BINS.0, WIDTH_BINS.1);
    let range = centred_range(market.path.bin_in_minute(position.opened_at), width);
    events.deposits(
        &mut stream,
        position.opened_at,
        range,
        position.invested.0,
        life,
    )?;
    if life > REBALANCE_AFTER && stream.below(REBALANCE_ONE_IN) == 0 {
        let at = part_way(position.opened_at, life, 2);
        let moved = centred_range(market.path.bin_in_minute(at), width);
        events.push(
            at,
            "rebalance",
            PositionEventKind::Rebalance { range: moved },
        );
    }
    let fees = position.claimed_fees.0;
    let mid_claim = if life > MID_CLAIM_AFTER { fees / 2 } else { 0 };
    if mid_claim > 0 {
        let at = part_way(position.opened_at, life, 3);
        let flow = events.flow(at, mid_claim)?;
        events.push(at, "claim", PositionEventKind::Claim(flow));
    }
    let closing = position.closed_at;
    let rest = fees.saturating_sub(mid_claim);
    if rest > 0 {
        let flow = events.flow(closing, rest)?;
        events.push(closing, "close", PositionEventKind::Claim(flow));
    }
    let withdrawal = events.flow(closing, position.withdrawn.0)?;
    events.push(closing, "close", PositionEventKind::Close { withdrawal });
    if position.unpriced_movements > 0 {
        events.forget_last_price();
    }
    Ok(events.list)
}

/// The movements of an open position so far.
pub(crate) fn open_events(
    seed: u64,
    position: &OpenPositionFacts,
    market: Market<'_>,
    now: Timestamp,
) -> Result<Vec<PositionEventFact>, DemoError> {
    let mut stream = Stream::of(seed, &format!("events:{}", position.id));
    let mut events = Events::new(position.id, market);
    let life = now.duration_since(position.opened_at);
    let range = BinRange {
        lower_bin_id: position.lower_bin_id,
        upper_bin_id: position.upper_bin_id,
    };
    events.deposits(
        &mut stream,
        position.opened_at,
        range,
        position.invested.0,
        life,
    )?;
    if position.claimed_fees.0 > 0 {
        let at = part_way(position.opened_at, life, 2);
        let flow = events.flow(at, position.claimed_fees.0)?;
        events.push(at, "claim", PositionEventKind::Claim(flow));
    }
    Ok(events.list)
}

/// The movements of one position as they are made.
struct Events<'a> {
    position: PositionId,
    market: Market<'a>,
    list: Vec<PositionEventFact>,
}

impl<'a> Events<'a> {
    /// No movement yet.
    fn new(position: PositionId, market: Market<'a>) -> Self {
        Self {
            position,
            market,
            list: Vec::new(),
        }
    }

    /// The opening with its deposit, and sometimes a second deposit a third into the life.
    fn deposits(
        &mut self,
        stream: &mut Stream,
        opened_at: Timestamp,
        range: BinRange,
        invested: i128,
        life: SignedDuration,
    ) -> Result<(), DemoError> {
        let adds = stream.below(ADD_ONE_IN) == 0 && invested > 0;
        let first = if adds {
            invested.saturating_mul(FIRST_DEPOSIT_PERCENT) / PERCENT
        } else {
            invested
        };
        let deposit = self.flow(opened_at, first)?;
        self.push(
            opened_at,
            "open",
            PositionEventKind::Open { range, deposit },
        );
        if adds {
            let at = part_way(opened_at, life, 3);
            let flow = self.flow(at, invested.saturating_sub(first))?;
            self.push(at, "add", PositionEventKind::Add(flow));
        }
        Ok(())
    }

    /// `value` quote units moved at `at`, half base and half quote at the bin of that minute.
    fn flow(&self, at: Timestamp, value: i128) -> Result<TokenFlow, DemoError> {
        let bin = self.market.path.bin_in_minute(at);
        let price = bin_price(bin, self.market.pool.bin_step)?;
        let half = u64::try_from(value.max(0) / 2).map_err(|_| DemoError::OutOfRange)?;
        let base = div_q64(half, price).ok_or(DemoError::OutOfRange)?;
        let base_value = mul_shr_64(base, price).ok_or(DemoError::OutOfRange)?;
        let base_value = i128::try_from(base_value).map_err(|_| DemoError::OutOfRange)?;
        let quote = value.max(0).saturating_sub(base_value);
        Ok(TokenFlow {
            base: RawTokenAmount(base),
            quote: RawTokenAmount(u128::try_from(quote).map_err(|_| DemoError::OutOfRange)?),
            value: QuoteUnits(value.max(0)),
        })
    }

    /// Records a movement of the transaction named `transaction` at `at`. The opening runs in
    /// the transaction that names the position.
    fn push(&mut self, at: Timestamp, transaction: &str, kind: PositionEventKind) {
        let signature = match kind {
            PositionEventKind::Open { .. } => self.position.opened_by,
            _ => signature(&format!(
                "{transaction}:{}:{}",
                self.position,
                at.as_second()
            )),
        };
        self.list.push(PositionEventFact {
            position: self.position,
            at,
            signature,
            active_bin_id: Some(self.market.path.bin_in_minute(at)),
            kind,
        });
    }

    /// Leaves the last movement without a bin price, as when its transaction does not say it.
    fn forget_last_price(&mut self) {
        if let Some(last) = self.list.last_mut() {
            last.active_bin_id = None;
        }
    }
}

/// A range of `width` bins around `active`.
fn centred_range(active: i32, width: i64) -> BinRange {
    let width = i32::try_from(width).unwrap_or(1).max(1);
    let lower = active.saturating_sub(width / 2);
    BinRange {
        lower_bin_id: lower,
        upper_bin_id: lower.saturating_add(width).saturating_sub(1),
    }
}

/// The start of the minute `1 / divisor` of the way through `life` from `start`.
fn part_way(start: Timestamp, life: SignedDuration, divisor: i32) -> Timestamp {
    let span = life.checked_div(divisor).unwrap_or(SignedDuration::ZERO);
    let at = start.saturating_add(span).unwrap_or(start);
    minute_start(at).max(start)
}

#[cfg(test)]
mod tests;
