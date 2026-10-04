//! The governor: what every request goes through before and after it is sent.
//!
//! Before: the credit meter books its cost against the budget, which may refuse it or defer its
//! class, then the rate limiter waits for a slot in the lane of its priority (a full lane defers
//! it too, and gives the credits back). After: the meter counts it with its outcome, or as
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

    /// Books the request's cost, then waits for a slot in its priority's lane to send it.
    pub(crate) async fn admit(
        &self,
        method: RpcMethod,
        priority: Priority,
    ) -> Result<(), BudgetRefusal> {
        let cost = cost(BilledMethod::Rpc(method));
        self.meter.reserve(cost, priority)?;
        if let Err(full) = self.limiter.acquire(priority).await {
            self.meter.release(cost);
            let wait = SignedDuration::try_from(full.wait).unwrap_or(SignedDuration::MAX);
            let until = self.clock.now().checked_add(wait).unwrap_or(Timestamp::MAX);
            return Err(BudgetRefusal::Deferred { until });
        }
        Ok(())
    }

    /// Marks a request as sent: it is counted with the outcome given to
    /// [`SentRequest::settle`], or as cancelled if it is dropped before that, since the provider
    /// may bill a request whose answer nobody waited for.
    pub(crate) fn send(&self, method: RpcMethod, context: CallContext) -> SentRequest<'_> {
        SentRequest {
            governor: self,
            method,
            context,
            is_counted: false,
        }
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
    pub(crate) fn admit_stream_open(&self) -> Result<(), BudgetRefusal> {
        self.meter
            .reserve(cost(BilledMethod::StreamOpen), Priority::Realtime)
    }

    /// Counts a stream connection attempt with how it ended.
    pub(crate) fn record_stream_open(&self, outcome: CallOutcome) {
        let method = BilledMethod::StreamOpen;
        self.meter
            .record(method, &STREAM_CONTEXT, outcome, cost(method));
    }

    /// Charges `units` started units of streamed data.
    pub(crate) fn charge_stream_data(&self, units: u64) {
        let method = BilledMethod::StreamData;
        let credits = Credits(cost(method).0.saturating_mul(units));
        self.meter.charge(method, &STREAM_CONTEXT, units, credits);
    }

    /// The hard limit that stops even live requests now, if one is reached.
    pub(crate) fn hard_refusal(&self) -> Option<BudgetRefusal> {
        self.meter.hard_refusal()
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
            .record(method, &self.context, outcome, cost(method));
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

    #[test]
    fn counts_a_settled_request_once_with_its_outcome() {
        let governor = governor();

        governor
            .send(RpcMethod::GetTransaction, context())
            .settle(CallOutcome::Timeout);

        assert_eq!(counted(&governor), vec![(CallOutcome::Timeout, 1)]);
    }

    #[test]
    fn counts_a_request_dropped_before_its_answer_as_cancelled() {
        let governor = governor();

        drop(governor.send(RpcMethod::GetTransaction, context()));

        assert_eq!(counted(&governor), vec![(CallOutcome::Cancelled, 1)]);
    }
}
