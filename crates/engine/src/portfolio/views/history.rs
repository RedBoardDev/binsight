//! History as the screens show it: pages of closed positions with the summary of each day they
//! touch, and the pools of the history for its filter.

use binsight_core::ratio::Percent;
use binsight_ledger::facts::{DailyRate, PositionId};
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::valued::Money;
use jiff::Timestamp;
use jiff::civil::Date;

use super::closed::ClosedPositionRow;
use super::refs::PoolRef;

/// A page of closed positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedPage {
    /// The positions, in the order asked for.
    pub items: Vec<ClosedPositionRow>,
    /// The key to read the next page after, when more positions match.
    pub next: Option<ClosedKey>,
    /// The instant the list is read at: later closes are left out of every page.
    pub as_of: Timestamp,
    /// How many positions match the filter at that instant, over every page.
    pub matched_count: usize,
    /// How many positions of the scope closed by that instant, whatever the filter.
    pub total_count: usize,
    /// The summary of every local day the page touches, over the whole filter (only when the
    /// list is sorted by closing time).
    pub day_groups: Option<Vec<DayGroup>>,
    /// UTC closing days of the entire matching list, with their effective conversion source.
    /// Used to invalidate currency-dependent cursors when rates change between snapshots.
    pub conversion_rates: Vec<(Date, Option<DailyRate>)>,
    /// The time zone of this same read context, used to bind local-day cursors.
    pub timezone: String,
}

/// The place of a closed position in a sorted list: its sort value, then its id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ClosedKey {
    /// Its value for the sort, as an exact integer (raw units, a percentage's raw value, seconds);
    /// `None` when unavailable (such values come last in both orders).
    pub value: Option<i128>,
    /// Its id.
    pub id: PositionId,
}

/// The summary of the positions of the filter closed on one local day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayGroup {
    /// The day.
    pub day: Date,
    /// How many closed.
    pub count: usize,
    /// How many gained.
    pub wins: usize,
    /// How many lost.
    pub losses: usize,
    /// How many ended flat.
    pub flat: usize,
    /// Closed lives whose native PnL sign is not proved yet.
    pub unclassified_count: usize,
    /// `wins / (wins + losses)`.
    pub win_rate: Figure<Percent>,
    /// The sum of their PnL.
    pub pnl: Figure<Money>,
}

/// A pool of the history, as the pool filter offers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolOption {
    /// The pool.
    pub pool: PoolRef,
    /// How many of its positions closed.
    pub closed_count: usize,
    /// How many of its positions are open.
    pub open_count: usize,
    /// When its latest position closed.
    pub last_closed_at: Option<Timestamp>,
}
