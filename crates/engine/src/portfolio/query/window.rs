//! Resolving the window of a read and naming it for the screens.

use binsight_ledger::report::period::{Period, Window};
use binsight_ledger::report::real_pnl::PnlTimeline;

use crate::portfolio::read_error::ReadError;
use crate::portfolio::scope::{ReadContext, Scope};
use crate::portfolio::snapshot::Snapshot;
use crate::portfolio::views::WindowView;

/// The window of `period` for `scope`, now (`all` starts at the scope's first activity).
pub(super) fn period_window(
    snapshot: &Snapshot,
    scope: Scope,
    period: Period,
    context: &ReadContext,
) -> Result<Window, ReadError> {
    let histories = snapshot.histories_in(scope);
    let first_activity = PnlTimeline::new(&histories, snapshot.rates()).first_activity();
    Ok(Window::of_period(
        period,
        context.now,
        &context.timezone,
        first_activity,
    )?)
}

/// How the screens show `window`.
pub(super) fn window_view(window: &Window, context: &ReadContext) -> WindowView {
    WindowView {
        scope: window.scope,
        start: window.start,
        end: window.end,
        timezone: context.timezone.iana_name().unwrap_or("UTC").to_owned(),
    }
}
