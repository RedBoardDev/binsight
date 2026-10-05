//! The governor: what every request goes through before and after it is sent.
//!
//! Before: the rate limiter waits for a slot in the lane of its priority, then the credit
//! meter atomically admits the cost at the instant of sending. Waiting requests spend nothing.
//! After: the meter counts it on that sending day with its outcome, or as
//! cancelled if the caller dropped it before the answer (at shutdown). The client calls the
//! governor on every attempt, retries included, so each one is paced and counted. This module
//! assembles the parts; each one lives in its own module.

mod billing_cycle;
mod budget_guard;
mod cost_table;
mod credit_meter;
mod daily_budget;
mod day_pace;
mod rate_limiter;
mod usage_counts;
mod waiting_lanes;

#[cfg(test)]
mod sending_tests;

pub use billing_cycle::{BillingCycleDay, InvalidCycleDay};
pub use budget_guard::CreditStanding;
pub use cost_table::BilledMethod;
pub(crate) use cost_table::STREAM_DATA_UNIT_BYTES;
pub use credit_meter::CreditMeter;
pub use usage_counts::CreditUsage;

use std::sync::Arc;
use std::time::Duration;

use binsight_core::clock::Clock;
use binsight_core::credits::{CallOutcome, Credits, Priority, Purpose};
use jiff::{SignedDuration, Timestamp};

use crate::error::BudgetRefusal;
use crate::plan::HeliusPlan;
use crate::rpc::{CallContext, RpcMethod};
use cost_table::cost;
use credit_meter::CreditAdmission;
pub(crate) use credit_meter::CreditBooking;
use rate_limiter::RateLimiter;

/// The pause after a 429 that did not say how long to wait.
const DEFAULT_COOL_DOWN_SECS: u64 = 1;

/// How the governor paces and budgets requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GovernorSettings {
    /// The requests sent per second, evenly spaced.
    pub requests_per_second: u32,
    /// The credits a billing cycle grants.
    pub cycle_credits: Credits,
    /// The day of the month billing cycles start on.
    pub cycle_day: BillingCycleDay,
    /// The credits that may be spent per UTC day before every request is refused, if any.
    pub daily_credit_limit: Option<Credits>,
}

impl GovernorSettings {
    /// The settings for `plan`, with cycles starting on the first of the month and an optional
    /// hard daily limit.
    pub const fn for_plan(plan: HeliusPlan, daily_credit_limit: Option<Credits>) -> Self {
        Self {
            requests_per_second: plan.requests_per_second(),
            cycle_credits: plan.monthly_credits(),
            cycle_day: BillingCycleDay::FIRST,
            daily_credit_limit,
        }
    }
}

/// Paces, admits and counts the requests of one client.
pub(crate) struct Governor {
    clock: Arc<dyn Clock>,
    limiter: RateLimiter,
    meter: CreditMeter,
}

impl std::fmt::Debug for Governor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Governor")
            .field("limiter", &self.limiter)
            .field("meter", &self.meter)
            .finish_non_exhaustive()
    }
}

impl Governor {
    pub(crate) fn new(settings: GovernorSettings, clock: Arc<dyn Clock>) -> Self {
        Self {
            limiter: RateLimiter::new(settings.requests_per_second),
            meter: CreditMeter::new(
                clock.clone(),
                settings.cycle_credits,
                settings.cycle_day,
                settings.daily_credit_limit,
            ),
            clock,
        }
    }

    /// The credit meter, for the engine to seed and drain.
    pub(crate) fn meter(&self) -> &CreditMeter {
        &self.meter
    }

    /// The current instant, on the clock the credits are dated by.
    pub(crate) fn now(&self) -> Timestamp {
        self.clock.now()
    }

    /// Waits for the priority lane, then admits and dates the request without another await.
    pub(crate) async fn admit(
        &self,
        method: RpcMethod,
        context: CallContext,
    ) -> Result<SentRequest<'_>, BudgetRefusal> {
        loop {
            self.wait_for_lane(context.priority).await?;
            let mut headroom = self.meter.headroom_changes();
            match self
                .meter
                .book(cost(BilledMethod::Rpc(method)), context.priority)?
            {
                CreditAdmission::Booked(booking) => {
                    return Ok(SentRequest {
                        governor: self,
                        method,
                        context,
                        booking,
                        is_counted: false,
                    });
                }
                CreditAdmission::WaitingForStreamData => {
                    // The meter owns the sender; it outlives this borrowed receiver.
                    let _ = headroom.changed().await;
                }
            }
        }
    }

    async fn wait_for_lane(&self, priority: Priority) -> Result<(), BudgetRefusal> {
        self.limiter.acquire(priority).await.map_err(|full| {
            let wait = SignedDuration::try_from(full.wait).unwrap_or(SignedDuration::MAX);
            let until = self.clock.now().checked_add(wait).unwrap_or(Timestamp::MAX);
            BudgetRefusal::Deferred { until }
        })
    }

    /// Holds every request back after the provider said "too many requests", the ones already
    /// waiting for a slot included.
    pub(crate) fn cool_down(&self, retry_after: Option<Duration>) {
        let pause = retry_after.unwrap_or(Duration::from_secs(DEFAULT_COOL_DOWN_SECS));
        self.limiter.cool_down(pause);
    }

    /// Refuses everything but an hourly probe after the provider said the cycle's credits are
    /// used up.
    pub(crate) fn credits_exhausted(&self) {
        self.meter.provider_refused();
    }

    /// Books the opening of a stream connection, a live request, if the budget admits it.
    pub(crate) fn admit_stream_open(&self) -> Result<CreditBooking, BudgetRefusal> {
        self.meter.book_stream_open(
            cost(BilledMethod::StreamOpen),
            cost(BilledMethod::StreamData),
        )
    }

    /// Releases first-unit headroom after the connection ends; no data was billed for it.
    pub(crate) fn stream_ended(&self) {
        self.meter.release_stream_headroom();
    }

    /// Counts a stream connection attempt with how it ended.
    pub(crate) fn record_stream_open(&self, booking: &CreditBooking, outcome: CallOutcome) {
        let method = BilledMethod::StreamOpen;
        self.meter.record(booking, method, &STREAM_CONTEXT, outcome);
    }

    /// Charges `units` started units of streamed data.
    pub(crate) fn charge_stream_data(&self, units: u64) -> Result<(), BudgetRefusal> {
        let method = BilledMethod::StreamData;
        let credits = Credits(cost(method).0.saturating_mul(units));
        self.meter.charge(method, &STREAM_CONTEXT, units, credits)
    }

    /// A hard limit or insufficient room for another streamed-data unit.
    pub(crate) fn stream_refusal(&self) -> Option<BudgetRefusal> {
        self.meter.stream_refusal(cost(BilledMethod::StreamData))
    }
}

/// What the stream's credits are filed under: live work, for no wallet in particular.
const STREAM_CONTEXT: CallContext = CallContext {
    priority: Priority::Realtime,
    purpose: Purpose::LiveStream,
    wallet: None,
};

/// A request on its way; dropping it unsettled counts it as cancelled.
#[derive(Debug)]
pub(crate) struct SentRequest<'governor> {
    governor: &'governor Governor,
    method: RpcMethod,
    context: CallContext,
    booking: CreditBooking,
    is_counted: bool,
}

impl SentRequest<'_> {
    /// Counts the request with how it ended.
    pub(crate) fn settle(mut self, outcome: CallOutcome) {
        self.count(outcome);
    }

    fn count(&mut self, outcome: CallOutcome) {
        if self.is_counted {
            return;
        }
        self.is_counted = true;
        let method = BilledMethod::Rpc(self.method);
        self.governor
            .meter
            .record(&self.booking, method, &self.context, outcome);
    }
}

impl Drop for SentRequest<'_> {
    fn drop(&mut self) {
        self.count(CallOutcome::Cancelled);
    }
}

#[cfg(test)]
mod tests {
    use binsight_core::clock::FixedClock;
    use binsight_core::credits::{Priority, Purpose};
    use jiff::Timestamp;

    use super::*;

    fn governor() -> Governor {
        let clock = Arc::new(FixedClock::new(
            Timestamp::from_second(1_790_000_000).unwrap(),
        ));
        Governor::new(GovernorSettings::for_plan(HeliusPlan::Free, None), clock)
    }

    fn context() -> CallContext {
        CallContext {
            priority: Priority::History,
            purpose: Purpose::TransactionFetch,
            wallet: None,
        }
    }

    fn counted(governor: &Governor) -> Vec<(CallOutcome, u64)> {
        let usages = governor.meter().drain();
        usages
            .into_iter()
            .map(|usage| (usage.outcome, usage.calls))
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn counts_a_settled_request_once_with_its_outcome() {
        let governor = governor();

        governor
            .admit(RpcMethod::GetTransaction, context())
            .await
            .unwrap()
            .settle(CallOutcome::Timeout);

        assert_eq!(counted(&governor), vec![(CallOutcome::Timeout, 1)]);
    }

    #[tokio::test(start_paused = true)]
    async fn counts_a_request_dropped_before_its_answer_as_cancelled() {
        let governor = governor();

        drop(
            governor
                .admit(RpcMethod::GetTransaction, context())
                .await
                .unwrap(),
        );

        assert_eq!(counted(&governor), vec![(CallOutcome::Cancelled, 1)]);
    }
}
