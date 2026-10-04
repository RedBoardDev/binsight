//! A chart series: bars and lines over buckets, with their share of the net worth.

use binsight_core::ratio::Percent;
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::period::Bucket;
use binsight_ledger::report::series::SeriesKind;
use binsight_ledger::report::valued::Money;
use jiff::Timestamp;

use super::window::WindowView;

/// A series over a window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeriesView {
    /// The window.
    pub window: WindowView,
    /// Which series.
    pub series: SeriesKind,
    /// The size of its buckets.
    pub bucket: Bucket,
    /// The headline figures.
    pub header: SeriesHeaderView,
    /// One point per bucket.
    pub points: Vec<SeriesPointView>,
}

/// The headline figures of a series.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeriesHeaderView {
    /// The net worth now, the gain, or the PnL of the positions closed in the window.
    pub value: Figure<Money>,
    /// For the net worth: its change over the window.
    pub change: Option<Figure<Money>>,
    /// For the net worth: the capital put in over the window.
    pub net_deposits: Option<Figure<Money>>,
}

/// One point of a series.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeriesPointView {
    /// The start of its bucket.
    pub start: Timestamp,
    /// The end of its bucket.
    pub end: Timestamp,
    /// The change over the bucket (none for the net worth).
    pub bar: Option<Figure<Money>>,
    /// The bar against the net worth at the start of the bucket.
    pub bar_share_of_net_worth: Option<Figure<Percent>>,
    /// The change since the start of the window, or the net worth.
    pub line: Figure<Money>,
    /// The line against the net worth at the start of the window.
    pub line_share_of_net_worth: Option<Figure<Percent>>,
}
