//! The requests counted since the last flush, grouped the way the credit report reads them.
//!
//! Counts are grouped per UTC day, method, priority, purpose, wallet and outcome and kept in
//! memory until the engine takes them to the database; counts that could not be written are
//! given back and handed over again with the next ones. This module only adds up; what a request
//! costs and whether it may be sent are decided elsewhere.

use std::collections::BTreeMap;

use binsight_core::credits::{CallOutcome, Credits, Priority, Purpose};
use binsight_solana::Address;
use jiff::civil::Date;

use crate::rpc::{CallContext, RpcMethod};

/// The credits spent by a group of identical requests on one day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreditUsage {
    /// The UTC day the requests were sent.
    pub day: Date,
    /// The method called.
    pub method: RpcMethod,
    /// The class of the calls.
    pub priority: Priority,
    /// The work they belonged to.
    pub purpose: Purpose,
    /// The wallet they served, if any.
    pub wallet: Option<Address>,
    /// How they ended.
    pub outcome: CallOutcome,
    /// How many requests were sent.
    pub calls: u64,
    /// The credits they cost.
    pub credits: Credits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct UsageKey {
    day: Date,
    method: RpcMethod,
    priority: Priority,
    purpose: Purpose,
    wallet: Option<Address>,
    outcome: CallOutcome,
}

/// The counts gathered since the last drain.
#[derive(Debug, Default)]
pub(super) struct UsageCounts {
    pending: BTreeMap<UsageKey, (u64, Credits)>,
}

impl UsageCounts {
    /// Counts one request of `method` sent on `day` for `context`, which ended with `outcome`.
    pub(super) fn count(
        &mut self,
        day: Date,
        method: RpcMethod,
        context: &CallContext,
        outcome: CallOutcome,
        cost: Credits,
    ) {
        let key = UsageKey {
            day,
            method,
            priority: context.priority,
            purpose: context.purpose,
            wallet: context.wallet,
            outcome,
        };
        self.add(key, 1, cost);
    }

    /// Takes every count gathered so far.
    pub(super) fn drain(&mut self) -> Vec<CreditUsage> {
        std::mem::take(&mut self.pending)
            .into_iter()
            .map(|(key, (calls, credits))| CreditUsage {
                day: key.day,
                method: key.method,
                priority: key.priority,
                purpose: key.purpose,
                wallet: key.wallet,
                outcome: key.outcome,
                calls,
                credits,
            })
            .collect()
    }

    /// Gives back counts taken by [`UsageCounts::drain`].
    pub(super) fn restore(&mut self, usages: Vec<CreditUsage>) {
        for usage in usages {
            let key = UsageKey {
                day: usage.day,
                method: usage.method,
                priority: usage.priority,
                purpose: usage.purpose,
                wallet: usage.wallet,
                outcome: usage.outcome,
            };
            self.add(key, usage.calls, usage.credits);
        }
    }

    fn add(&mut self, key: UsageKey, calls: u64, credits: Credits) {
        let entry = self.pending.entry(key).or_insert((0, Credits::ZERO));
        entry.0 = entry.0.saturating_add(calls);
        entry.1 = entry.1.saturating_add(credits);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> CallContext {
        CallContext {
            priority: Priority::History,
            purpose: Purpose::TransactionFetch,
            wallet: Some(Address::from_bytes([1; 32])),
        }
    }

    fn day() -> Date {
        "2026-09-21".parse().unwrap()
    }

    fn count(counts: &mut UsageCounts, outcome: CallOutcome) {
        counts.count(
            day(),
            RpcMethod::GetTransaction,
            &context(),
            outcome,
            Credits(1),
        );
    }

    #[test]
    fn groups_identical_requests_and_empties_on_drain() {
        let mut counts = UsageCounts::default();
        count(&mut counts, CallOutcome::Ok);
        count(&mut counts, CallOutcome::Ok);
        count(&mut counts, CallOutcome::Timeout);

        let drained = counts.drain();

        assert_eq!(drained.len(), 2);
        let ok = drained
            .iter()
            .find(|usage| usage.outcome == CallOutcome::Ok)
            .unwrap();
        assert_eq!((ok.calls, ok.credits), (2, Credits(2)));
        assert_eq!(ok.day, day());
        assert_eq!(counts.drain(), Vec::new());
    }

    #[test]
    fn hands_restored_counts_over_again_with_the_new_ones() {
        let mut counts = UsageCounts::default();
        count(&mut counts, CallOutcome::Ok);
        let unsaved = counts.drain();
        count(&mut counts, CallOutcome::Ok);

        counts.restore(unsaved);

        let drained = counts.drain();
        assert_eq!(drained.len(), 1);
        assert_eq!((drained[0].calls, drained[0].credits), (2, Credits(2)));
    }
}
