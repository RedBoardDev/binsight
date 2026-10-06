//! Capture references when one event appends activity; the legacy path allocates no trace.

use super::{
    ActivityDiagnostic, ActivityProvenance, ActivityProvenanceError, ActivityRef, EventEffect,
    EventSource,
};
use crate::activity::{MovementKind, TxActivity};
use crate::event::{DlmmEvent, LocatedEvent};

pub(in crate::activity) enum Capture {
    Legacy,
    Provenance {
        sources: Vec<EventSource>,
        rows: Vec<ActivityProvenance>,
        diagnostics: Vec<ActivityDiagnostic>,
    },
}

#[derive(Clone, Copy)]
pub(in crate::activity) struct Checkpoint {
    source: Option<EventSource>,
    expansion: Expansion,
    lifecycle: usize,
    movements: usize,
    rewards: usize,
}

#[derive(Clone, Copy)]
enum Expansion {
    Single,
    Rebalance,
}

impl Capture {
    pub(super) fn new(events: &[LocatedEvent]) -> Result<Self, ActivityProvenanceError> {
        let sources = events
            .iter()
            .enumerate()
            .map(|(index, event)| {
                let index = checked_index(index)?;
                Ok(EventSource::new(index, event.at))
            })
            .collect::<Result<_, ActivityProvenanceError>>()?;
        Ok(Self::Provenance {
            sources,
            rows: Vec::new(),
            diagnostics: Vec::new(),
        })
    }

    pub(in crate::activity) fn sources(&self) -> &[EventSource] {
        match self {
            Self::Legacy => &[],
            Self::Provenance { sources, .. } => sources,
        }
    }

    pub(in crate::activity) fn before(
        &self,
        index: usize,
        event: &DlmmEvent,
        activity: &TxActivity,
    ) -> Checkpoint {
        Checkpoint {
            source: self.sources().get(index).copied(),
            expansion: if matches!(event, DlmmEvent::Rebalancing(_)) {
                Expansion::Rebalance
            } else {
                Expansion::Single
            },
            lifecycle: activity.lifecycle.len(),
            movements: activity.movements.len(),
            rewards: activity.reward_claims.len(),
        }
    }

    pub(in crate::activity) fn after(&mut self, start: Checkpoint, activity: &TxActivity) {
        let (Self::Provenance { rows, .. }, Some(source)) = (self, start.source) else {
            return;
        };
        for index in start.lifecycle..activity.lifecycle.len() {
            rows.push(ActivityProvenance::new(
                ActivityRef::Lifecycle { index },
                source,
                EventEffect::Single,
            ));
        }
        for (index, movement) in activity.movements.iter().enumerate().skip(start.movements) {
            let effect = match (start.expansion, movement.kind) {
                (Expansion::Rebalance, MovementKind::RebalanceWithdrawal) => {
                    EventEffect::RebalanceWithdrawal
                }
                (Expansion::Rebalance, MovementKind::RebalanceDeposit) => {
                    EventEffect::RebalanceDeposit
                }
                (Expansion::Rebalance, MovementKind::FeeClaim) => EventEffect::RebalanceFees,
                _ => EventEffect::Single,
            };
            rows.push(ActivityProvenance::new(
                ActivityRef::Movement { index },
                source,
                effect,
            ));
        }
        for (index, reward) in activity
            .reward_claims
            .iter()
            .enumerate()
            .skip(start.rewards)
        {
            let effect = match (start.expansion, reward.reward_index) {
                (Expansion::Rebalance, 0) => EventEffect::RebalanceReward0,
                (Expansion::Rebalance, 1) => EventEffect::RebalanceReward1,
                _ => EventEffect::Single,
            };
            rows.push(ActivityProvenance::new(
                ActivityRef::RewardClaim { index },
                source,
                effect,
            ));
        }
    }

    pub(in crate::activity) fn finish(&mut self, observed: Vec<ActivityDiagnostic>) {
        if let Self::Provenance { diagnostics, .. } = self {
            *diagnostics = observed;
        }
    }

    pub(super) fn into_parts(self) -> (Vec<ActivityProvenance>, Vec<ActivityDiagnostic>) {
        match self {
            Self::Legacy => (Vec::new(), Vec::new()),
            Self::Provenance {
                rows, diagnostics, ..
            } => (rows, diagnostics),
        }
    }
}

fn checked_index(index: usize) -> Result<u32, ActivityProvenanceError> {
    u32::try_from(index).map_err(|_| ActivityProvenanceError::EventIndexOverflow { index })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_decoded_event_rank_that_cannot_fit() {
        let maximum = usize::try_from(u32::MAX).unwrap();
        assert_eq!(checked_index(maximum).unwrap(), u32::MAX);
        if let Some(overflow) = maximum.checked_add(1) {
            assert!(matches!(
                checked_index(overflow),
                Err(ActivityProvenanceError::EventIndexOverflow { .. })
            ));
        }
    }
}
