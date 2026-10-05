//! Counting the credits every request costs, and refusing requests the budget does not admit.
//!
//! Every request sent is counted with its outcome, retries included, because the provider may
//! bill each one: the meter would rather overstate than understate. The counts (`usage_counts`)
//! are handed over by [`CreditMeter::drain`] for the engine to persist (the chain client does not
//! know the database), and given back by [`CreditMeter::restore`] when they could not be. Before a request
//! leaves, the meter books its cost against the budget (`budget_guard`), which may refuse or
//! defer it; [`CreditMeter::seed`] restores the day's and the cycle's spending from the database
//! at startup, so a restart does not reset the limits.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use binsight_core::clock::{Clock, utc_day};
use binsight_core::credits::{CallOutcome, Credits, Priority};
use jiff::civil::Date;
use tokio::sync::{Notify, watch};

use super::billing_cycle::BillingCycleDay;
use super::budget_guard::{BudgetGuard, CreditStanding};
use super::cost_table::BilledMethod;
use super::daily_budget::{BudgetLimits, Spend, Spending};
use super::usage_counts::{CreditUsage, UsageCounts};
use crate::error::BudgetRefusal;
use crate::rpc::CallContext;

/// A request's immutable spending bucket and admitted cost.
#[derive(Debug)]
pub(crate) struct CreditBooking {
    pub(crate) day: Date,
    pub(crate) cost: Credits,
    provider_probe: Option<Arc<()>>,
}

/// Actual admission or a temporary hold for the stream's not-yet-delivered first data.
#[derive(Debug)]
pub(crate) enum CreditAdmission {
    /// The cost was admitted and dated for immediate sending.
    Booked(CreditBooking),
    /// Only unused first-data headroom prevents admission.
    WaitingForStreamData,
}

/// Counts the credits spent and guards the budget.
pub struct CreditMeter {
    clock: Arc<dyn Clock>,
    state: Mutex<MeterState>,
    changed: Notify,
    headroom_released: watch::Sender<()>,
}

struct MeterState {
    guard: BudgetGuard,
    counts: UsageCounts,
    stream_headroom: Credits,
}

impl CreditMeter {
    /// A meter with nothing spent, budgeting `cycle_credits` per billing cycle starting on
    /// `cycle_day`, with a hard daily limit if `daily_limit` is set.
    pub(crate) fn new(
        clock: Arc<dyn Clock>,
        cycle_credits: Credits,
        cycle_day: BillingCycleDay,
        daily_limit: Option<Credits>,
    ) -> Self {
        let limits = BudgetLimits {
            cycle_credits,
            daily_limit,
        };
        let guard = BudgetGuard::new(limits, cycle_day, clock.now());
        Self {
            clock,
            changed: Notify::new(),
            headroom_released: watch::channel(()).0,
            state: Mutex::new(MeterState {
                guard,
                counts: UsageCounts::default(),
                stream_headroom: Credits::ZERO,
            }),
        }
    }

    /// Sets what was already spent today and in the current billing cycle (today included), as
    /// persisted before a restart.
    pub fn seed(&self, spent_today: Credits, spent_cycle: Credits) {
        let spending = Spending {
            today: spent_today,
            cycle: spent_cycle.max(spent_today),
        };
        self.lock().guard.seed(spending, self.clock.now());
        self.changed.notify_one();
    }

    /// The first day of the current billing cycle, to read its spending back from the database.
    pub fn cycle_first_day(&self) -> Date {
        self.lock().guard.cycle_first_day(self.clock.now())
    }

    /// Where today's and the cycle's spending stand.
    pub fn standing(&self) -> CreditStanding {
        self.lock().guard.standing(self.clock.now())
    }

    /// The credits spent today (UTC), seed included.
    #[cfg(test)]
    pub(crate) fn spent_today(&self) -> Credits {
        self.standing().spent_today
    }

    /// Takes every count gathered since the last drain.
    pub fn drain(&self) -> Vec<CreditUsage> {
        self.lock().counts.drain()
    }

    /// Gives back counts taken by [`CreditMeter::drain`] that could not be persisted, so the next
    /// drain hands them over again. The spending totals are not touched: they already include
    /// them.
    pub fn restore(&self, usages: Vec<CreditUsage>) {
        self.lock().counts.restore(usages);
    }

    /// Books `cost` for a request of `priority` before it is sent, if the budget admits it.
    #[cfg(test)]
    pub(crate) fn reserve(&self, cost: Credits, priority: Priority) -> Result<(), BudgetRefusal> {
        self.book(cost, priority).map(|admission| {
            assert!(
                matches!(admission, CreditAdmission::Booked(_)),
                "this test helper requires no stream hold"
            );
        })
    }

    /// Admits and dates actual spend, distinguishing a temporary stream hold from a limit.
    /// A waiting call has no booking and no spending until it retries successfully.
    pub(crate) fn book(
        &self,
        cost: Credits,
        priority: Priority,
    ) -> Result<CreditAdmission, BudgetRefusal> {
        let mut state = self.lock();
        let now = self.clock.now();
        let held = state.stream_headroom;
        let spend = Spend {
            priority,
            cost,
            now,
        };
        if let Err(refusal) = state.guard.book_with_headroom(spend, held) {
            if held > Credits::ZERO && state.guard.check_booking(spend, Credits::ZERO).is_ok() {
                return Ok(CreditAdmission::WaitingForStreamData);
            }
            return Err(refusal);
        }
        self.changed.notify_one();
        Ok(CreditAdmission::Booked(CreditBooking {
            day: utc_day(now),
            cost,
            provider_probe: state.guard.provider_probe(),
        }))
    }

    /// Admits the opening and holds its first data unit against concurrent RPC admission.
    /// Only the opening is spending until the server actually delivers data.
    pub(crate) fn book_stream_open(
        &self,
        opening: Credits,
        first_unit: Credits,
    ) -> Result<CreditBooking, BudgetRefusal> {
        let mut state = self.lock();
        let now = self.clock.now();
        if let Some(refusal) = state.guard.provider_refusal_for_stream(now) {
            return Err(refusal);
        }
        state.guard.book_with_headroom(
            Spend {
                priority: Priority::Realtime,
                cost: opening,
                now,
            },
            first_unit,
        )?;
        state.stream_headroom = first_unit;
        Ok(CreditBooking {
            day: utc_day(now),
            cost: opening,
            provider_probe: None,
        })
    }

    /// Releases unused first-unit headroom when a connection attempt or session ends.
    pub(crate) fn release_stream_headroom(&self) {
        self.lock().stream_headroom = Credits::ZERO;
        self.headroom_released.send_replace(());
    }

    /// Subscribes before checking admission so a release between check and wait is retained.
    pub(crate) fn headroom_changes(&self) -> watch::Receiver<()> {
        self.headroom_released.subscribe()
    }

    /// How many requests are listening for the first-data hold to end.
    #[cfg(test)]
    pub(crate) fn headroom_waiters(&self) -> usize {
        self.headroom_released.receiver_count()
    }

    /// Wakes the stream when RPC spending may require a preventive close.
    pub(crate) async fn changed(&self) {
        self.changed.notified().await;
    }

    /// Whether another streamed unit is covered, without holding idle credits indefinitely.
    pub(crate) fn stream_refusal(&self, unit: Credits) -> Option<BudgetRefusal> {
        let mut state = self.lock();
        let now = self.clock.now();
        if let Some(refusal) = state.guard.provider_refusal_for_stream(now) {
            return Some(refusal);
        }
        if let Some(refusal) = state.guard.hard_refusal(now) {
            return Some(refusal);
        }
        state
            .guard
            .check_headroom(
                Spend {
                    priority: Priority::Realtime,
                    cost: Credits::ZERO,
                    now,
                },
                unit,
            )
            .err()
    }

    /// Notes that the provider refused a request because the cycle's credits are used up.
    pub(crate) fn provider_refused(&self) {
        self.lock().guard.provider_refused(self.clock.now());
        self.changed.notify_one();
    }

    /// Counts one request that was sent, with how it ended.
    pub(crate) fn record(
        &self,
        booking: &CreditBooking,
        method: BilledMethod,
        context: &CallContext,
        outcome: CallOutcome,
    ) {
        let mut state = self.lock();
        if outcome == CallOutcome::Ok
            && state.guard.provider_served(booking.provider_probe.as_ref())
        {
            self.changed.notify_one();
        }
        state
            .counts
            .count(booking.day, method, context, outcome, (1, booking.cost));
    }

    /// Counts `units` of `method` the provider delivered without being asked, such as streamed
    /// data, and adds their cost to the spending: they were spent whatever the budget says.
    pub(crate) fn charge(
        &self,
        method: BilledMethod,
        context: &CallContext,
        units: u64,
        cost: Credits,
    ) -> Result<(), BudgetRefusal> {
        let mut state = self.lock();
        let now = self.clock.now();
        state.guard.add(cost, now);
        state.counts.count(
            utc_day(now),
            method,
            context,
            CallOutcome::Ok,
            (units, cost),
        );
        state.stream_headroom = Credits::ZERO;
        self.headroom_released.send_replace(());
        let next_unit = super::cost_table::cost(BilledMethod::StreamData);
        state.guard.check_headroom(
            Spend {
                priority: Priority::Realtime,
                cost: Credits::ZERO,
                now,
            },
            next_unit,
        )
    }

    fn lock(&self) -> MutexGuard<'_, MeterState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl std::fmt::Debug for CreditMeter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CreditMeter")
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
#[path = "tests/credit_meter.rs"]
mod tests;
