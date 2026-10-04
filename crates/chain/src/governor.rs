//! The governor: what every request goes through before and after it is sent.
//!
//! Before: the credit meter books its cost against the day's allowance (and refuses it past the
//! hard daily limit), then the rate limiter waits for a slot. After: the meter counts it with its
//! outcome, or as cancelled if the caller dropped it before the answer (at shutdown). The client calls the governor on every attempt, retries included, so each one is paced
//! and counted. This module assembles the parts; each one lives in its own module.

mod cost_table;
mod credit_meter;
mod rate_limiter;

pub use credit_meter::{CreditMeter, CreditUsage};

use std::sync::Arc;
use std::time::Duration;

use binsight_core::clock::Clock;
use binsight_core::credits::{CallOutcome, Credits};

use crate::error::BudgetRefusal;
use crate::plan::HeliusPlan;
use crate::rpc::{CallContext, RpcMethod};
use cost_table::cost;
use rate_limiter::RateLimiter;

/// The pause after a 429 that did not say how long to wait.
const DEFAULT_COOL_DOWN_SECS: u64 = 1;

/// How the governor paces and caps requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GovernorSettings {
    /// The requests sent per second, evenly spaced.
    pub requests_per_second: u32,
    /// The credits that may be spent per UTC day before every request is refused, if any.
    pub daily_credit_limit: Option<Credits>,
}

impl GovernorSettings {
    /// The settings for `plan`, with an optional hard daily limit.
    pub const fn for_plan(plan: HeliusPlan, daily_credit_limit: Option<Credits>) -> Self {
        Self {
            requests_per_second: plan.requests_per_second(),
            daily_credit_limit,
        }
    }
}

/// Paces, admits and counts the requests of one client.
#[derive(Debug)]
pub(crate) struct Governor {
    limiter: RateLimiter,
    meter: CreditMeter,
}

impl Governor {
    pub(crate) fn new(settings: GovernorSettings, clock: Arc<dyn Clock>) -> Self {
        Self {
            limiter: RateLimiter::new(settings.requests_per_second),
            meter: CreditMeter::new(clock, settings.daily_credit_limit),
        }
    }

    /// The credit meter, for the engine to seed and drain.
    pub(crate) fn meter(&self) -> &CreditMeter {
        &self.meter
    }

    /// Books the request's cost, then waits for a slot to send it.
    pub(crate) async fn admit(&self, method: RpcMethod) -> Result<(), BudgetRefusal> {
        self.meter.reserve(cost(method))?;
        self.limiter.acquire().await;
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
}

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
        let cost = cost(self.method);
        self.governor
            .meter
            .record(self.method, &self.context, outcome, cost);
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
