//! Proven position lifetimes determine whether a historical point needs an open-PnL mark.

use jiff::Timestamp;

use super::WalletHistoryFacts;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PositionLifetime {
    pub(super) opened_at: Timestamp,
    pub(super) closed_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(super) struct OpenExposure {
    intervals: Vec<PositionLifetime>,
    first_activity: Option<Timestamp>,
}

impl OpenExposure {
    pub(super) fn of(facts: WalletHistoryFacts<'_>) -> Self {
        let lifetimes = facts
            .closed
            .iter()
            .map(|(position, _)| PositionLifetime {
                opened_at: position.opened_at,
                closed_at: Some(position.closed_at),
            })
            .chain(facts.open.iter().map(|position| PositionLifetime {
                opened_at: position.opened_at,
                closed_at: None,
            }))
            .collect();
        Self::from_lifetimes(lifetimes)
    }

    pub(super) fn from_lifetimes(mut lifetimes: Vec<PositionLifetime>) -> Self {
        lifetimes.sort_by_key(|life| life.opened_at);
        let first_activity = lifetimes.first().map(|life| life.opened_at);
        let mut intervals: Vec<PositionLifetime> = Vec::new();
        for life in lifetimes {
            if life.closed_at == Some(life.opened_at) {
                continue;
            }
            if let Some(last) = intervals
                .last_mut()
                .filter(|last| last.closed_at.is_none_or(|end| life.opened_at <= end))
            {
                last.closed_at = match (last.closed_at, life.closed_at) {
                    (Some(left), Some(right)) => Some(left.max(right)),
                    _ => None,
                };
                continue;
            }
            intervals.push(life);
        }
        Self {
            intervals,
            first_activity,
        }
    }

    pub(super) fn first_activity(&self) -> Option<Timestamp> {
        self.first_activity
    }

    pub(super) fn is_open_at(&self, instant: Timestamp) -> bool {
        let count = self
            .intervals
            .partition_point(|life| life.opened_at <= instant);
        count
            .checked_sub(1)
            .and_then(|index| self.intervals.get(index))
            .is_some_and(|life| life.contains(instant))
    }
}

impl PositionLifetime {
    pub(super) fn contains(self, instant: Timestamp) -> bool {
        self.opened_at <= instant && self.closed_at.is_none_or(|closed| instant < closed)
    }
}

#[cfg(test)]
#[path = "exposure/tests.rs"]
mod tests;
