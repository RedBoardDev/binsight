//! The hourly open-PnL marks of a wallet.
//!
//! Between its opening and its close, a position's open PnL is taken to grow in proportion to
//! the time elapsed towards its final PnL; an open position grows towards its PnL now. A mark is
//! the sum over the positions open at its hour, in whole lamports.

use binsight_core::money::SignedLamports;
use binsight_ledger::facts::OpenPnlMark;
use jiff::Timestamp;

use super::sweep::CashFlows;
use crate::error::DemoError;

/// Seconds in an hour.
const SECONDS_PER_HOUR: i64 = 3_600;

/// The marks of a wallet, every hour from the hour after `first_activity` until `anchor`.
pub(crate) fn hourly_marks(
    flows: &CashFlows<'_>,
    first_activity: Timestamp,
    anchor: Timestamp,
) -> Result<Vec<OpenPnlMark>, DemoError> {
    let first = first_activity
        .as_second()
        .saturating_div(SECONDS_PER_HOUR)
        .saturating_add(1);
    let last = anchor
        .as_second()
        .saturating_sub(1)
        .saturating_div(SECONDS_PER_HOUR);
    let count = usize::try_from(last.saturating_sub(first).saturating_add(1)).unwrap_or(0);
    let mut totals = vec![0_i128; count];
    let spans = flows
        .closed
        .iter()
        .map(|(position, valuation)| {
            Ok((
                position.opened_at,
                position.closed_at,
                final_pnl(&valuation.pnl)?,
            ))
        })
        .chain(flows.open.iter().map(|(position, valuation)| {
            Ok((position.opened_at, anchor, final_pnl(&valuation.pnl)?))
        }))
        .collect::<Result<Vec<_>, DemoError>>()?;
    for (opened, closed, pnl) in spans {
        add_span(
            &mut totals,
            first,
            (opened.as_second(), closed.as_second()),
            pnl,
        );
    }
    totals
        .into_iter()
        .zip(first..)
        .map(|(open_pnl, hour)| {
            let at = Timestamp::from_second(hour.saturating_mul(SECONDS_PER_HOUR))
                .map_err(|_| DemoError::OutOfRange)?;
            Ok(OpenPnlMark {
                wallet: flows.wallet,
                at,
                open_pnl: SignedLamports(open_pnl),
            })
        })
        .collect()
}

/// Adds the growing open PnL of one position to the hours it was open (`opened <= hour < closed`).
fn add_span(totals: &mut [i128], first_hour: i64, (opened, closed): (i64, i64), pnl: i128) {
    let duration = i128::from(closed.saturating_sub(opened)).max(1);
    let start = opened
        .saturating_add(SECONDS_PER_HOUR)
        .saturating_sub(1)
        .saturating_div(SECONDS_PER_HOUR);
    let mut hour = start.max(first_hour);
    while hour.saturating_mul(SECONDS_PER_HOUR) < closed {
        let instant = hour.saturating_mul(SECONDS_PER_HOUR);
        let elapsed = i128::from(instant.saturating_sub(opened));
        let index = usize::try_from(hour.saturating_sub(first_hour)).unwrap_or(usize::MAX);
        if let Some(total) = totals.get_mut(index) {
            let grown = pnl
                .saturating_mul(elapsed)
                .checked_div(duration)
                .unwrap_or(0);
            *total = total.saturating_add(grown);
        }
        hour = hour.saturating_add(1);
    }
}

/// The SOL PnL a position ends on (or has now).
fn final_pnl(
    figure: &binsight_ledger::report::figure::Figure<binsight_ledger::report::valued::Valued>,
) -> Result<i128, DemoError> {
    figure
        .value()
        .map(|valued| valued.sol.0)
        .ok_or(DemoError::OutOfRange)
}
