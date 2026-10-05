//! The series of the charts: net worth, real PnL and closed-position PnL, bucket by bucket.
//!
//! Each point has a bar (the change over its bucket) and a line (the cumulated change since the
//! start of the window, or the net worth itself), each also as a share of the net worth: a bar
//! against the net worth at the start of its bucket, a line against the net worth at the start of
//! the window. The last point ends now and reads the live figures, so the real PnL line ends on
//! the gain and its share on the gain percentage.

use binsight_core::ratio::Percent;

use super::ReadRuleError;
use super::figure::Figure;
use super::period::{TimeSpan, Window};
use super::real_pnl::{PnlPoint, PnlTimeline};
use super::valued::{Currency, Valued, percent_of, subtract_valued};

/// Which series.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SeriesKind {
    /// The net worth at the end of each bucket.
    NetWorth,
    /// The real PnL gained in each bucket and since the start of the window.
    RealPnl,
    /// The PnL of the positions closed in each bucket and since the start of the window.
    Positions,
}

/// What a series is computed over.
#[derive(Debug, Clone, Copy)]
pub struct SeriesRequest<'a> {
    /// Which series.
    pub kind: SeriesKind,
    /// The window.
    pub window: &'a Window,
    /// Its buckets, which partition it.
    pub buckets: &'a [TimeSpan],
    /// The currency the shares are computed in.
    pub currency: Currency,
}

/// One point of a series.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeriesPoint {
    /// The bucket.
    pub span: TimeSpan,
    /// The change over the bucket; `None` for the net worth.
    pub bar: Option<Figure<Valued>>,
    /// The bar against the net worth at the start of the bucket; `None` for the net worth.
    pub bar_share_of_net_worth: Option<Figure<Percent>>,
    /// The change since the start of the window (the net worth itself for the net worth).
    pub line: Figure<Valued>,
    /// The line against the net worth at the start of the window; `None` for the net worth.
    pub line_share_of_net_worth: Option<Figure<Percent>>,
}

/// The headline figures of a series.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeriesHeader {
    /// The net worth now, the gain, or the PnL of the positions closed in the window.
    pub value: Figure<Valued>,
    /// For the net worth: its change over the window.
    pub change: Option<Figure<Valued>>,
    /// For the net worth: the capital put in over the window, net of withdrawals.
    pub net_deposits: Option<Figure<Valued>>,
}

/// A series and its headline figures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Series {
    /// The headline figures.
    pub header: SeriesHeader,
    /// One point per bucket, in order.
    pub points: Vec<SeriesPoint>,
}

/// The series `request` asks for, with the `live` point now.
///
/// # Errors
///
/// Returns [`ReadRuleError`] when a sum or a quotient overflows.
pub fn series(
    timeline: &PnlTimeline<'_>,
    live: &PnlPoint,
    request: SeriesRequest<'_>,
) -> Result<Series, ReadRuleError> {
    let window = request.window;
    let start = timeline.at(window.start)?;
    let mut points = Vec::with_capacity(request.buckets.len());
    let mut bucket_start = start.clone();
    for span in request.buckets {
        let end = if span.end >= window.end {
            live.clone()
        } else {
            timeline.at(span.end)?
        };
        points.push(point(
            timeline,
            *span,
            [&start, &bucket_start, &end],
            request,
        )?);
        bucket_start = end;
    }
    Ok(Series {
        header: header(timeline, live, &start, request)?,
        points,
    })
}

/// The point of the bucket `span`, from the points at the window's start, the bucket's start
/// and the bucket's end.
fn point(
    timeline: &PnlTimeline<'_>,
    span: TimeSpan,
    [start, bucket_start, end]: [&PnlPoint; 3],
    request: SeriesRequest<'_>,
) -> Result<SeriesPoint, ReadRuleError> {
    let (bar, line) = match request.kind {
        SeriesKind::NetWorth => {
            return Ok(SeriesPoint {
                span,
                bar: None,
                bar_share_of_net_worth: None,
                line: end.net_worth.clone(),
                line_share_of_net_worth: None,
            });
        }
        SeriesKind::RealPnl => (
            subtract_valued(end.real_pnl.clone(), bucket_start.real_pnl.clone())?,
            subtract_valued(end.real_pnl.clone(), start.real_pnl.clone())?,
        ),
        SeriesKind::Positions => (
            timeline.positions_pnl(span.start, span.end)?,
            timeline.positions_pnl(request.window.start, span.end)?,
        ),
    };
    Ok(SeriesPoint {
        span,
        bar_share_of_net_worth: Some(percent_of(&bar, &bucket_start.net_worth, request.currency)?),
        line_share_of_net_worth: Some(percent_of(&line, &start.net_worth, request.currency)?),
        bar: Some(bar),
        line,
    })
}

/// The headline figures of the series.
fn header(
    timeline: &PnlTimeline<'_>,
    live: &PnlPoint,
    start: &PnlPoint,
    request: SeriesRequest<'_>,
) -> Result<SeriesHeader, ReadRuleError> {
    let window = request.window;
    Ok(match request.kind {
        SeriesKind::NetWorth => SeriesHeader {
            value: live.net_worth.clone(),
            change: Some(subtract_valued(
                live.net_worth.clone(),
                start.net_worth.clone(),
            )?),
            net_deposits: Some(timeline.net_deposits(window)?),
        },
        SeriesKind::RealPnl => SeriesHeader {
            value: subtract_valued(live.real_pnl.clone(), start.real_pnl.clone())?,
            change: None,
            net_deposits: None,
        },
        SeriesKind::Positions => SeriesHeader {
            value: timeline.positions_pnl(window.start, window.end)?,
            change: None,
            net_deposits: None,
        },
    })
}
