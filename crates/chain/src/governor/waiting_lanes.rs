//! The callers waiting for a request slot: one bounded lane per priority, first come first
//! served within a lane, the most urgent lane first.
//!
//! Each caller holds a ticket and a wake-up of its own, so only the caller served next is woken
//! when a slot is taken or a caller ahead gives up. Lanes are bounded: background work waits in
//! the database, not in memory. This module keeps the queues; pacing them on the clock is the
//! rate limiter's job.

use std::collections::VecDeque;
use std::sync::Arc;

use binsight_core::credits::Priority;
use tokio::sync::Notify;

/// How many callers may wait in the lane of `priority`. The live lanes are wide: a burst of
/// activity must never be turned away. Background lanes are narrow.
const fn lane_capacity(priority: Priority) -> usize {
    match priority {
        Priority::Realtime | Priority::CatchUp => 256,
        Priority::History => 32,
        Priority::Valuation => 4,
    }
}

/// The position of `priority`'s lane, the most urgent first.
const fn lane_index(priority: Priority) -> usize {
    match priority {
        Priority::Realtime => 0,
        Priority::CatchUp => 1,
        Priority::History => 2,
        Priority::Valuation => 3,
    }
}

/// A caller's ticket in its lane.
#[derive(Debug, Clone)]
pub(super) struct Ticket {
    lane: usize,
    number: u64,
    /// Woken when this caller becomes the one served next.
    pub(super) wake: Arc<Notify>,
}

/// The lanes of waiting callers.
#[derive(Debug, Default)]
pub(super) struct WaitingLanes {
    lanes: [VecDeque<Ticket>; 4],
    next_number: u64,
}

impl WaitingLanes {
    /// Queues a caller of `priority`; if its lane is full, returns how many callers wait ahead
    /// of it, its lane and the more urgent ones.
    pub(super) fn join(&mut self, priority: Priority) -> Result<Ticket, usize> {
        let index = lane_index(priority);
        let lane_length = self.lanes.get(index).map_or(0, VecDeque::len);
        if lane_length >= lane_capacity(priority) {
            return Err(self.lanes.iter().take(index + 1).map(VecDeque::len).sum());
        }
        let ticket = Ticket {
            lane: index,
            number: self.next_number,
            wake: Arc::new(Notify::new()),
        };
        self.next_number = self.next_number.wrapping_add(1);
        if let Some(lane) = self.lanes.get_mut(index) {
            lane.push_back(ticket.clone());
        }
        Ok(ticket)
    }

    /// Whether `ticket` is the caller served next: the first of the most urgent lane that has
    /// one.
    pub(super) fn is_first(&self, ticket: &Ticket) -> bool {
        self.first()
            .is_some_and(|first| first.number == ticket.number)
    }

    /// Takes `ticket` out of its lane and wakes whoever is served next; returns whether it was
    /// still there.
    pub(super) fn leave(&mut self, ticket: &Ticket) -> bool {
        let Some(lane) = self.lanes.get_mut(ticket.lane) else {
            return false;
        };
        let position = lane
            .iter()
            .position(|queued| queued.number == ticket.number);
        let left = position
            .and_then(|position| lane.remove(position))
            .is_some();
        if left && let Some(first) = self.first() {
            first.wake.notify_one();
        }
        left
    }

    fn first(&self) -> Option<&Ticket> {
        self.lanes.iter().find_map(VecDeque::front)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_the_most_urgent_lane_first_then_in_order_of_arrival() {
        let mut lanes = WaitingLanes::default();
        let history = lanes.join(Priority::History).unwrap();
        let first_live = lanes.join(Priority::Realtime).unwrap();
        let second_live = lanes.join(Priority::Realtime).unwrap();

        assert!(lanes.is_first(&first_live));
        lanes.leave(&first_live);
        assert!(lanes.is_first(&second_live));
        lanes.leave(&second_live);
        assert!(lanes.is_first(&history));
    }

    #[test]
    fn turns_a_caller_away_from_a_full_lane_and_counts_who_waits_ahead() {
        let mut lanes = WaitingLanes::default();
        lanes.join(Priority::Realtime).unwrap();
        for _ in 0..4 {
            lanes.join(Priority::Valuation).unwrap();
        }

        assert_eq!(lanes.join(Priority::Valuation).unwrap_err(), 5);
        assert!(lanes.join(Priority::History).is_ok());
    }
}
