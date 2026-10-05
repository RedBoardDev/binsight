//! Hourly simulated open-PnL marks preserve each position valuation's exactness.
//!
//! The scenario interpolates a position's eventual PnL during its open lifetime. Interpolation
//! uses checked lamports; it never converts an unavailable valuation into a zero mark.

use binsight_core::error::AmountError;
use binsight_core::money::SignedLamports;
use binsight_ledger::facts::OpenPnlMark;
use binsight_ledger::report::figure::{Combination, Figure};
use binsight_ledger::report::valued::{Currency, Valued, resolve};
use jiff::Timestamp;

use super::sweep::CashFlows;
use crate::error::DemoError;

const SECONDS_PER_HOUR: i64 = 3_600;
const NANOSECONDS_PER_SECOND: i128 = 1_000_000_000;
const NANOSECONDS_PER_HOUR: i128 = 3_600_000_000_000;

/// The marks after the first activity and strictly before the scenario anchor.
pub(crate) fn hourly_marks(
    flows: &CashFlows<'_>,
    first_activity: Timestamp,
    anchor: Timestamp,
) -> Result<Vec<OpenPnlMark>, DemoError> {
    let first = first_activity
        .as_nanosecond()
        .div_euclid(NANOSECONDS_PER_HOUR)
        .checked_add(1)
        .ok_or(DemoError::OutOfRange)?;
    let last = anchor
        .as_nanosecond()
        .checked_sub(1)
        .ok_or(DemoError::OutOfRange)?
        .div_euclid(NANOSECONDS_PER_HOUR);
    let first = i64::try_from(first).map_err(|_| DemoError::OutOfRange)?;
    let last = i64::try_from(last).map_err(|_| DemoError::OutOfRange)?;
    let count = if last < first {
        0
    } else {
        usize::try_from(
            last.checked_sub(first)
                .and_then(|value| value.checked_add(1))
                .ok_or(DemoError::OutOfRange)?,
        )
        .map_err(|_| DemoError::OutOfRange)?
    };
    let mut totals = vec![Figure::Complete(SignedLamports::ZERO); count];
    for (position, valuation) in &flows.closed {
        add_span(
            &mut totals,
            first,
            (position.opened_at, position.closed_at),
            &final_pnl(&valuation.pnl),
        )?;
    }
    for (position, valuation) in &flows.open {
        add_span(
            &mut totals,
            first,
            (position.opened_at, anchor),
            &final_pnl(&valuation.pnl),
        )?;
    }
    totals
        .into_iter()
        .enumerate()
        .map(|(index, open_pnl)| {
            let hour = i64::try_from(index)
                .ok()
                .and_then(|index| first.checked_add(index))
                .ok_or(DemoError::OutOfRange)?;
            let at = hour
                .checked_mul(SECONDS_PER_HOUR)
                .ok_or(DemoError::OutOfRange)?;
            Ok(OpenPnlMark {
                wallet: flows.wallet,
                at: Timestamp::from_second(at).map_err(|_| DemoError::OutOfRange)?,
                open_pnl,
            })
        })
        .collect()
}

fn add_span(
    totals: &mut [Figure<SignedLamports>],
    first_hour: i64,
    (opened, closed): (Timestamp, Timestamp),
    pnl: &Figure<SignedLamports>,
) -> Result<(), DemoError> {
    let duration = closed
        .as_nanosecond()
        .checked_sub(opened.as_nanosecond())
        .ok_or(DemoError::OutOfRange)?;
    if duration < 0 {
        return Err(DemoError::OutOfRange);
    }
    if duration == 0 {
        return Ok(());
    }
    let start_hour = opened
        .as_nanosecond()
        .div_euclid(NANOSECONDS_PER_HOUR)
        .checked_add(i128::from(
            opened.as_nanosecond().rem_euclid(NANOSECONDS_PER_HOUR) != 0,
        ))
        .ok_or(DemoError::OutOfRange)?;
    let start_hour = i64::try_from(start_hour)
        .map_err(|_| DemoError::OutOfRange)?
        .max(first_hour);
    let start = usize::try_from(
        start_hour
            .checked_sub(first_hour)
            .ok_or(DemoError::OutOfRange)?,
    )
    .map_err(|_| DemoError::OutOfRange)?;
    for (index, total) in totals.iter_mut().enumerate().skip(start) {
        let instant = i64::try_from(index)
            .ok()
            .and_then(|index| first_hour.checked_add(index))
            .and_then(|hour| hour.checked_mul(SECONDS_PER_HOUR))
            .ok_or(DemoError::OutOfRange)?;
        let instant = i128::from(instant)
            .checked_mul(NANOSECONDS_PER_SECOND)
            .ok_or(DemoError::OutOfRange)?;
        if instant >= closed.as_nanosecond() {
            break;
        }
        let elapsed = instant
            .checked_sub(opened.as_nanosecond())
            .ok_or(DemoError::OutOfRange)?;
        let grown = pnl.clone().try_map(|pnl| {
            pnl.0
                .checked_mul(elapsed)
                .and_then(|product| product.checked_div(duration))
                .map(SignedLamports)
                .ok_or(AmountError::Overflow)
        })?;
        *total = total
            .clone()
            .combine(grown, Combination::Sum, SignedLamports::try_add)?;
    }
    Ok(())
}

fn final_pnl(figure: &Figure<Valued>) -> Figure<SignedLamports> {
    resolve(figure, Currency::Sol).map(|money| SignedLamports(money.raw))
}

#[cfg(test)]
#[path = "marks/tests.rs"]
mod tests;
