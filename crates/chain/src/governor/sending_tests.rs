//! Admission follows the rate lane and retains the sending day across responses and shutdown.

use std::sync::Arc;
use std::time::Duration;

use binsight_core::clock::FixedClock;
use binsight_core::credits::{CallOutcome, Credits, Priority, Purpose};
use jiff::{SignedDuration, Timestamp};

use super::{BillingCycleDay, CreditAdmission, Governor, GovernorSettings};
use crate::plan::HeliusPlan;
use crate::rpc::{CallContext, RpcMethod};

fn governor(at: &str, cycle_day: BillingCycleDay) -> (Arc<FixedClock>, Arc<Governor>) {
    let clock = Arc::new(FixedClock::new(at.parse::<Timestamp>().unwrap()));
    let mut settings = GovernorSettings::for_plan(HeliusPlan::Free, Some(Credits(2)));
    settings.requests_per_second = 1;
    settings.cycle_day = cycle_day;
    (clock.clone(), Arc::new(Governor::new(settings, clock)))
}

fn context(priority: Priority) -> CallContext {
    CallContext {
        priority,
        purpose: Purpose::TransactionFetch,
        wallet: None,
    }
}

#[tokio::test(start_paused = true)]
async fn spends_nothing_when_a_waiting_request_is_cancelled_after_midnight() {
    let (clock, governor) = governor("2026-10-31T23:59:59Z", BillingCycleDay::FIRST);
    governor
        .admit(RpcMethod::GetTransaction, context(Priority::Realtime))
        .await
        .unwrap()
        .settle(CallOutcome::Ok);
    let queued = governor.clone();
    let waiting = tokio::spawn(async move {
        queued
            .admit(RpcMethod::GetTransaction, context(Priority::History))
            .await
            .unwrap()
            .settle(CallOutcome::Ok);
    });
    tokio::task::yield_now().await;
    assert_eq!(governor.meter().standing().spent_today, Credits(1));
    clock.advance(SignedDuration::from_secs(2)).unwrap();
    waiting.abort();
    let _ = waiting.await;
    assert_eq!(governor.meter().standing().spent_today, Credits::ZERO);
    assert_eq!(governor.meter().standing().spent_cycle, Credits::ZERO);
    let usages = governor.meter().drain();
    assert_eq!(usages.len(), 1);
    assert_eq!(usages[0].day.to_string(), "2026-10-31");
    assert_eq!(usages[0].credits, Credits(1));
}

#[tokio::test(start_paused = true)]
async fn admits_waiting_calls_on_the_new_day_and_configured_cycle() {
    for (at, next_day, cycle_day) in [
        ("2026-10-31T23:59:59Z", "2026-11-01", BillingCycleDay::FIRST),
        (
            "2026-10-14T23:59:59Z",
            "2026-10-15",
            BillingCycleDay::try_from(15).unwrap(),
        ),
    ] {
        let (clock, governor) = governor(at, cycle_day);
        governor
            .admit(RpcMethod::GetTransaction, context(Priority::Realtime))
            .await
            .unwrap()
            .settle(CallOutcome::Ok);
        governor.meter().drain();
        governor.cool_down(Some(Duration::from_secs(3)));
        let queued = governor.clone();
        let waiting = tokio::spawn(async move {
            queued
                .admit(RpcMethod::GetTransaction, context(Priority::CatchUp))
                .await
                .unwrap()
                .settle(CallOutcome::Ok);
        });
        tokio::task::yield_now().await;
        clock.advance(SignedDuration::from_secs(3)).unwrap();
        tokio::time::advance(Duration::from_secs(3)).await;
        waiting.await.unwrap();
        let standing = governor.meter().standing();
        assert_eq!(standing.spent_today, Credits(1));
        assert_eq!(standing.spent_cycle, Credits(1));
        assert_eq!(standing.cycle_first_day.to_string(), next_day);
        assert_eq!(governor.meter().drain()[0].day.to_string(), next_day);
    }
}

#[tokio::test(start_paused = true)]
async fn dates_delayed_responses_and_cancellations_on_the_sending_day() {
    for outcome in [None, Some(CallOutcome::Ok)] {
        let (clock, governor) = governor("2026-10-31T23:59:59Z", BillingCycleDay::FIRST);
        let sent = governor
            .admit(RpcMethod::GetTransaction, context(Priority::Realtime))
            .await
            .unwrap();
        clock.advance(SignedDuration::from_secs(2)).unwrap();
        match outcome {
            Some(outcome) => sent.settle(outcome),
            None => drop(sent),
        }
        let usage = governor.meter().drain();
        assert_eq!(usage[0].day.to_string(), "2026-10-31");
        assert_eq!(usage[0].outcome, outcome.unwrap_or(CallOutcome::Cancelled));
        assert_eq!(governor.meter().standing().spent_today, Credits::ZERO);
    }
}

#[tokio::test(start_paused = true)]
async fn headroom_release_between_check_and_wait_is_not_lost() {
    let clock = Arc::new(FixedClock::new("2026-10-05T12:00:00Z".parse().unwrap()));
    let governor = Governor::new(
        GovernorSettings::for_plan(HeliusPlan::Free, Some(Credits(3))),
        clock,
    );
    governor.admit_stream_open().unwrap();
    let mut released = governor.meter.headroom_changes();
    assert!(matches!(
        governor.meter.book(Credits(1), Priority::Realtime).unwrap(),
        CreditAdmission::WaitingForStreamData
    ));
    governor.stream_ended();
    tokio::time::timeout(Duration::ZERO, released.changed())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        governor.meter.book(Credits(1), Priority::Realtime).unwrap(),
        CreditAdmission::Booked(_)
    ));
}
