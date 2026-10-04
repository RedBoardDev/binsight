//! Reads about the statistics: the chart series.

use crate::portfolio::answer::Answer;
use crate::portfolio::query::SeriesRequest;
use crate::portfolio::views::SeriesView;

/// What the API reads about the statistics.
pub trait StatsReads: Send + Sync {
    /// A chart series of a scope over a period.
    fn stats_series(&self, request: SeriesRequest) -> Answer<'_, SeriesView>;
}
