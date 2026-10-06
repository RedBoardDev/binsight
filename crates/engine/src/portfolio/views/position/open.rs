//! Open positions as the screens show them: rows with their range and bins, and their totals.

use binsight_core::ratio::Percent;
use binsight_core::units::RawTokenAmount;
use binsight_ledger::facts::{PositionId, Strategy};
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::open::{Composition, RangeStatus};
use binsight_ledger::report::valued::Money;
use jiff::Timestamp;

use crate::portfolio::views::{Freshness, PoolRef, PriceView, WalletRef};

/// The open positions of a scope and their totals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenPositionsView {
    /// The positions, sorted as asked.
    pub items: Vec<OpenPositionRow>,
    /// How fresh their figures are.
    pub freshness: Freshness,
    /// Their totals.
    pub totals: OpenTotals,
}

/// The totals of open positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenTotals {
    /// How many.
    pub count: usize,
    /// How many are out of range.
    pub out_of_range_count: usize,
    /// Their value.
    pub value: Figure<Money>,
    /// What they invested.
    pub invested: Figure<Money>,
    /// What they withdrew.
    pub withdrawn: Figure<Money>,
    /// invested − withdrawn.
    pub net_invested: Figure<Money>,
    /// The fees they claimed.
    pub claimed_fees: Figure<Money>,
    /// Farming rewards, separately from swap fees.
    pub rewards: Figure<Money>,
    /// The fees they could claim.
    pub unclaimed_fees: Figure<Money>,
    /// claimed + unclaimed fees.
    pub fees: Figure<Money>,
    /// Their open PnL.
    pub pnl: Figure<Money>,
    /// Their PnL as a percentage of their net investment.
    pub pnl_pct: Figure<Percent>,
}

/// One open position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenPositionRow {
    /// Its identity.
    pub id: PositionId,
    /// The wallet that owns it.
    pub wallet: WalletRef,
    /// Its pool.
    pub pool: PoolRef,
    /// How its liquidity is spread.
    pub strategy: Option<Strategy>,
    /// When it opened.
    pub opened_at: Timestamp,
    /// How long it has been open at the instant shared by this read, in seconds.
    pub held_seconds: i64,
    /// The current price (the active bin); `None` when the pool's quote cannot be valued.
    pub price: Option<PriceView>,
    /// The lower numeric displayed price bound; the range's bin ids are the pool's own.
    pub lower: Option<PriceView>,
    /// The upper numeric displayed price bound; the range's bin ids are the pool's own.
    pub upper: Option<PriceView>,
    /// Where the price stands against the range.
    pub range: RangeView,
    /// Its liquidity, bin by bin.
    pub bins: BinChart,
    /// The value of its liquidity.
    pub value: Figure<Money>,
    /// What it invested.
    pub invested: Figure<Money>,
    /// What it withdrew.
    pub withdrawn: Figure<Money>,
    /// invested − withdrawn.
    pub net_invested: Figure<Money>,
    /// The fees it claimed.
    pub claimed_fees: Figure<Money>,
    /// Farming rewards, separately from swap fees.
    pub rewards: Figure<Money>,
    /// The fees it could claim.
    pub unclaimed_fees: Figure<Money>,
    /// claimed + unclaimed fees.
    pub fees: Figure<Money>,
    /// Its open PnL.
    pub pnl: Figure<Money>,
    /// Its PnL as a percentage of what it invested.
    pub pnl_pct: Figure<Percent>,
    /// Its PnL per day held.
    pub dpr: Figure<Percent>,
    /// Its PnL per year held; `None` before a full day.
    pub apr: Option<Figure<Percent>>,
    /// Its value as a share of its wallet's net worth.
    pub share_of_net_worth: Figure<Percent>,
}

/// Where the price stands against a position's range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeView {
    /// Inside, above or below.
    pub status: RangeStatus,
    /// Since when it is on that side; `None` when it never moved since the opening.
    pub since: Option<Timestamp>,
    /// How far the price can fall to the bottom of the range, in percent of the price.
    pub margin_down: Figure<Percent>,
    /// How far the price can rise to the top of the range, in percent of the price.
    pub margin_up: Figure<Percent>,
    /// What the position holds.
    pub composition: Composition,
}

/// A position's liquidity, bin by bin (bins are grouped beyond [`MAX_BIN_BARS`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinChart {
    /// The pool's active bin.
    pub active_bin_id: i32,
    /// The lowest bin of the range.
    pub lower_bin_id: i32,
    /// The highest bin of the range.
    pub upper_bin_id: i32,
    /// One bar per bin (or group of bins), lowest first.
    pub bars: Vec<BinBar>,
}

/// The most bars a bin chart has.
pub const MAX_BIN_BARS: usize = 70;

/// One bar of a bin chart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinBar {
    /// Its first bin.
    pub bin_id: i32,
    /// The price of that bin; `None` when the pool's quote cannot be valued.
    pub price: Option<PriceView>,
    /// Its displayed base token, in raw units; the source keeps the pool's X/Y.
    pub base: RawTokenAmount,
    /// Its displayed quote token, in raw units; the source keeps the pool's X/Y.
    pub quote: RawTokenAmount,
    /// Relative depth at each bin's own price, in the selected token; unsupported pools show the
    /// depth of the pool's Y token, which never enters a financial figure.
    pub height: binsight_core::ratio::Ratio,
}
