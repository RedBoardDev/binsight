//! One position as the drawer shows it: the same row as in its list, and its price chart.

use super::chart::ChartView;
use super::open::OpenPositionRow;
use crate::portfolio::views::{ClosedPositionRow, Freshness};

/// A position, open or closed, with its chart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionDetailView {
    /// The position and its figures.
    pub position: PositionState,
    /// Its price chart: the window, the range band and the movements.
    pub chart: ChartView,
}

/// A position with the figures of its state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PositionState {
    /// Still open: valued at its pool's active bin.
    Open {
        /// The same row as in the open positions.
        row: Box<OpenPositionRow>,
        /// How fresh its figures are.
        freshness: Freshness,
    },
    /// Closed: its figures are final.
    Closed(Box<ClosedPositionRow>),
}
