//! The hourly open-PnL marks of the test wallet.

use binsight_core::money::SignedLamports;
use binsight_ledger::facts::{ClosedPositionFacts, OpenPnlMark};
use jiff::SignedDuration;

use super::{NOW_SECONDS, WALLET, at, position_pnl};

/// Hourly marks: each position open at the hour contributes its final PnL in proportion to the
/// time it has been open.
pub(crate) fn hourly_marks(
    start: i64,
    closed: &[ClosedPositionFacts],
    open_opened: Option<i64>,
    open_pnl_now: i128,
) -> Vec<OpenPnlMark> {
    let hour = SignedDuration::from_hours(1).as_secs();
    let elapsed = |from: i64, to: i64| i128::from(to - from);
    let mut marks = Vec::new();
    let mut instant = start - start % hour + hour;
    while instant < NOW_SECONDS {
        let mut open_pnl = 0;
        for position in closed {
            let opened = position.opened_at.as_second();
            let closed_at = position.closed_at.as_second();
            if opened <= instant && instant < closed_at {
                open_pnl +=
                    position_pnl(position) * elapsed(opened, instant) / elapsed(opened, closed_at);
            }
        }
        if let Some(opened) = open_opened.filter(|opened| *opened <= instant) {
            open_pnl += open_pnl_now * elapsed(opened, instant) / elapsed(opened, NOW_SECONDS);
        }
        marks.push(OpenPnlMark {
            wallet: WALLET,
            at: at(instant),
            open_pnl: SignedLamports(open_pnl),
        });
        instant += hour;
    }
    marks
}
