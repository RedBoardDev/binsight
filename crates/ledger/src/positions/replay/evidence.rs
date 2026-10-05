//! Empty shells require whole-life coverage; positive gross activity never disappears in pricing.

use crate::positions::{
    LifetimeDiagnostic, PositionLifetime, PositionReplayContext, RawActivityEvidence,
};

pub(super) fn finish(
    lifetime: &mut PositionLifetime,
    context: PositionReplayContext,
    diagnostics: &mut Vec<LifetimeDiagnostic>,
) {
    let opened = lifetime.opened.at;
    let end = match lifetime.closed {
        Some(closed) => closed.at,
        None => Some(context.observed_at),
    };
    let covered = match (opened, end) {
        (Some(opened), Some(end)) if opened <= end && end <= context.observed_at => {
            context.history.covers(opened) && context.history.covers(end)
        }
        (Some(_), Some(_)) => {
            diagnostics.push(LifetimeDiagnostic::InconsistentLifetimeDates {
                position: lifetime.id,
            });
            false
        }
        _ => false,
    };
    lifetime.raw_activity = if lifetime.has_nonzero {
        RawActivityEvidence::ObservedNonzero
    } else if covered && context.sources_contiguous && !lifetime.has_unknown {
        RawActivityEvidence::ProvenEmpty
    } else {
        RawActivityEvidence::Unknown
    };
}
