//! The movements of every position, made to add up to its figures.
//!
//! A position opens with a deposit over a range around the bin of its opening minute, sometimes
//! adds to it, claims part of its fees on the way when it lives long enough, and (once closed)
//! claims the rest and withdraws everything in its closing transaction. The deposits add up to
//! what it invested, the withdrawals to what it withdrew and the claims to its claimed fees, to
//! the unit. Each movement runs at the bin of its minute on the pool's price path, so its marker
//! falls inside its candle; its tokens are split half base, half quote at that bin's exact price.

use binsight_core::units::RawTokenAmount;
use binsight_ledger::facts::{
    BinRange, ChainOrder, ClosedPositionFacts, OpenPositionFacts, PhysicalSide, PoolFacts,
    PositionEventFact, PositionEventKind, PositionId, QuoteUnits, RebalanceFlow, TokenFlow,
};
use binsight_solana::Signature;
use binsight_solana::transaction::InstructionPosition;
use jiff::{SignedDuration, Timestamp};

use super::liquidity::split_native;
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

/// Slots per ten seconds (a slot lasts about 400 ms).
const SLOTS_PER_TEN_SECONDS: u64 = 25;

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
        let movement = RebalanceFlow {
            instruction: InstructionPosition {
                top: 0,
                inner: Some(0),
            },
            flow: events.flow(at, position.invested.0)?,
        };
        events.push(
            at,
            "rebalance",
            PositionEventKind::RebalanceWithdrawal(movement),
        );
        events.push(
            at,
            "rebalance",
            PositionEventKind::RebalanceDeposit {
                movement,
                range: Some(moved),
            },
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
    if position.withdrawn.0 > 0 {
        let withdrawal = events.flow(closing, position.withdrawn.0)?;
        events.push(closing, "close", PositionEventKind::Remove(withdrawal));
    }
    events.push(closing, "close", PositionEventKind::Closed);
    if !position.unpriced_movements.is_none() {
        events.forget_last_price()?;
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
        self.push(
            opened_at,
            "open",
            PositionEventKind::Created { range: Some(range) },
        );
        if first > 0 {
            let deposit = self.flow(opened_at, first)?;
            self.push(opened_at, "open", PositionEventKind::Add(deposit));
        }
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
        let selected = self
            .market
            .pool
            .quote_convention()
            .ok_or(DemoError::UnknownPool)?;
        let (base, quote) = split_native(
            RawTokenAmount(u128::try_from(value).map_err(|_| DemoError::OutOfRange)?),
            selected,
            price,
        )?;
        Ok(TokenFlow {
            base,
            quote,
            value: QuoteUnits(value),
            valuation: binsight_ledger::facts::FlowValuation::Complete,
        })
    }

    /// Records a movement of the transaction named `transaction` at `at`. The opening runs in
    /// the transaction that names the position.
    fn push(&mut self, at: Timestamp, transaction: &str, kind: PositionEventKind) {
        let signature = if transaction == "open" {
            self.position.opened_by
        } else {
            signature(&format!(
                "{transaction}:{}:{}",
                self.position,
                at.as_second()
            ))
        };
        let earlier_in_transaction = self
            .list
            .iter()
            .filter(|event| event.signature == signature)
            .count();
        self.list.push(PositionEventFact {
            position: self.position,
            at,
            order: chain_order(at, &signature, earlier_in_transaction),
            signature,
            active_bin_id: Some(self.market.path.bin_in_minute(at)),
            kind,
        });
    }

    /// Leaves the last movement without a bin price, as when its transaction does not say it.
    fn forget_last_price(&mut self) -> Result<(), DemoError> {
        let selected = self
            .market
            .pool
            .quote_convention()
            .ok_or(DemoError::UnknownPool)?;
        if let Some(last) = self
            .list
            .iter_mut()
            .rev()
            .find(|event| event.kind.flow().is_some())
        {
            last.active_bin_id = None;
            if let PositionEventKind::Remove(flow) = &mut last.kind {
                flow.valuation = binsight_ledger::facts::FlowValuation::QuoteOnly;
                let raw_quote = RawTokenAmount(
                    u128::try_from(flow.value.0).map_err(|_| DemoError::OutOfRange)?,
                );
                match selected.side() {
                    PhysicalSide::X => flow.base = raw_quote,
                    PhysicalSide::Y => flow.quote = raw_quote,
                }
            }
        }
        Ok(())
    }
}

/// A plausible place in the chain for a movement at `at`: the slot of that second (about two and
/// a half a second), a transaction index read from the signature, so two transactions of one
/// second differ, and the movement's rank in its transaction.
fn chain_order(at: Timestamp, signature: &Signature, rank: usize) -> ChainOrder {
    let seconds = u64::try_from(at.as_second()).unwrap_or(0);
    let [first, second, ..] = *signature.as_bytes();
    ChainOrder {
        slot: seconds.saturating_mul(SLOTS_PER_TEN_SECONDS) / 10,
        transaction_index: u32::from(u16::from_be_bytes([first, second])),
        event_index: u32::try_from(rank).unwrap_or(u32::MAX),
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
