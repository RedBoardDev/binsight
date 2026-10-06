//! Closed positions as the screens show them: rows, totals and the recent closes.

use binsight_core::ratio::Percent;
use binsight_ledger::facts::{PositionId, Strategy};
use binsight_ledger::report::closed::Outcome;
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::valued::Money;
use jiff::Timestamp;
use jiff::civil::Date;

use super::refs::{PoolRef, WalletRef};
use super::window::WindowView;

/// How a closed position's PnL was measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PnlMethodView {
    /// Through the FIFO cost basis of its tokens.
    Fifo,
    /// At the bin price of each movement.
    Pool,
}

/// One closed position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedPositionRow {
    /// Its identity.
    pub id: PositionId,
    /// The wallet that owned it.
    pub wallet: WalletRef,
    /// Its pool.
    pub pool: PoolRef,
    /// How its liquidity was spread.
    pub strategy: Option<Strategy>,
    /// When it opened.
    pub opened_at: Timestamp,
    /// When it closed.
    pub closed_at: Timestamp,
    /// How long it was held, in seconds.
    pub held_seconds: i64,
    /// What it invested.
    pub invested: Figure<Money>,
    /// What it withdrew.
    pub withdrawn: Figure<Money>,
    /// The fees it claimed.
    pub fees: Figure<Money>,
    /// Farming rewards, separately from swap fees.
    pub rewards: Figure<Money>,
    /// The fees as a percentage of what it invested.
    pub fees_pct: Figure<Percent>,
    /// Its PnL (the market PnL when measured by FIFO, the liquidity PnL otherwise).
    pub pnl: Figure<Money>,
    /// Its PnL as a percentage of what it invested.
    pub pnl_pct: Figure<Percent>,
    /// Its liquidity PnL: withdrawn + fees − invested.
    pub lp_pnl: Figure<Money>,
    /// Its FIFO market PnL, when measured that way.
    pub market_pnl: Option<Figure<Money>>,
    /// How its PnL was measured.
    pub method: PnlMethodView,
    /// The sign of its native PnL, or `Unknown` when unpriced movements or rewards hide it.
    pub outcome: Outcome,
    /// Its PnL per day held, as a percentage of what it invested.
    pub dpr: Figure<Percent>,
    /// Whether nothing ever moved (an empty shell).
    pub is_shell: bool,
}

/// The totals of a set of closed positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedTotalsView {
    /// How many.
    pub count: usize,
    /// How many gained.
    pub wins: usize,
    /// How many lost.
    pub losses: usize,
    /// How many ended flat (exactly even, or empty shells).
    pub flat: usize,
    /// Closed lives whose native PnL sign is not proved yet.
    pub unclassified_count: usize,
    /// `wins / (wins + losses)`.
    pub win_rate: Figure<Percent>,
    /// The sum of their PnL.
    pub pnl: Figure<Money>,
    /// `Σ PnL / Σ invested`.
    pub pnl_pct: Figure<Percent>,
    /// The sum of their fees.
    pub fees: Figure<Money>,
    /// Farming rewards, separately from swap fees.
    pub rewards: Figure<Money>,
    /// The sum invested.
    pub invested: Figure<Money>,
    /// The sum withdrawn.
    pub withdrawn: Figure<Money>,
    /// The mean holding time, in seconds.
    pub average_held_seconds: Option<i64>,
    /// The median holding time, in seconds.
    pub median_held_seconds: Option<i64>,
}

/// The positions closed on one local day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedDay {
    /// The day.
    pub day: Date,
    /// Its window.
    pub window: WindowView,
    /// The totals of every position closed that day.
    pub totals: ClosedTotalsView,
    /// The latest of them, at most [`RECENT_CLOSES_PER_DAY`].
    pub items: Vec<ClosedPositionRow>,
    /// How many more closed that day.
    pub remaining_count: usize,
}

/// The most rows a day of recent closes shows.
pub const RECENT_CLOSES_PER_DAY: usize = 20;

/// The positions closed today and yesterday.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentClosesView {
    /// Today, then yesterday.
    pub days: Vec<ClosedDay>,
    /// The latest close of all, when nothing closed today or yesterday.
    pub last_close: Option<ClosedPositionRow>,
}
