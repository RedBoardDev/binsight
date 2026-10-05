//! Credit accounting and provider refusals on injected time.

use binsight_core::clock::FixedClock;
use jiff::{SignedDuration, Timestamp};

use binsight_core::credits::Purpose;
use binsight_solana::Address;

use super::*;
use crate::rpc::RpcMethod;

/// 2026-09-21 at 14:13 UTC.
const SEPTEMBER_21_AFTERNOON: i64 = 1_790_000_000;

fn context() -> CallContext {
    CallContext {
        priority: Priority::History,
        purpose: Purpose::TransactionFetch,
        wallet: Some(Address::from_bytes([1; 32])),
    }
}

fn meter(limit: Option<u64>) -> (Arc<FixedClock>, CreditMeter) {
    let clock = Arc::new(FixedClock::new(
        Timestamp::from_second(SEPTEMBER_21_AFTERNOON).unwrap(),
    ));
    let meter = CreditMeter::new(
        clock.clone(),
        Credits(1_000_000),
        BillingCycleDay::FIRST,
        limit.map(Credits),
    );
    (clock, meter)
}

fn booking(meter: &CreditMeter) -> CreditBooking {
    let admission = meter.book(Credits(1), Priority::Realtime).unwrap();
    let CreditAdmission::Booked(booking) = admission else {
        panic!("no stream headroom is held in this test");
    };
    booking
}

fn record_ok(meter: &CreditMeter, booking: &CreditBooking) {
    meter.record(
        booking,
        BilledMethod::Rpc(RpcMethod::GetTransaction),
        &context(),
        CallOutcome::Ok,
    );
}

#[test]
fn an_answer_to_a_request_sent_before_the_refusal_cannot_lift_it() {
    let (_clock, meter) = meter(None);
    let first = booking(&meter);
    let second = booking(&meter);
    meter.record(
        &first,
        BilledMethod::Rpc(RpcMethod::GetTransaction),
        &context(),
        CallOutcome::RateLimited,
    );
    meter.provider_refused();

    record_ok(&meter, &second);

    assert!(meter.standing().is_refusing_all);
    assert!(meter.book(Credits(1), Priority::Realtime).is_err());
    assert_eq!(meter.spent_today(), Credits(2));
}

#[test]
fn a_probe_answer_cannot_lift_a_newer_refusal_at_the_same_instant() {
    let (clock, meter) = meter(None);
    meter.provider_refused();
    clock.advance(SignedDuration::from_hours(1)).unwrap();
    let old_probe = booking(&meter);
    meter.provider_refused();

    record_ok(&meter, &old_probe);

    assert!(meter.standing().is_refusing_all);
    assert!(meter.book(Credits(1), Priority::Realtime).is_err());
}

#[test]
fn an_old_cycle_probe_cannot_lift_a_new_cycle_refusal() {
    let (clock, meter) = meter(None);
    clock.set("2026-09-30T22:00:00Z".parse().unwrap());
    meter.provider_refused();
    clock.advance(SignedDuration::from_hours(1)).unwrap();
    let old_probe = booking(&meter);
    clock.advance(SignedDuration::from_hours(1)).unwrap();
    meter.provider_refused();

    record_ok(&meter, &old_probe);

    assert!(meter.standing().is_refusing_all);
    assert_eq!(meter.spent_today(), Credits::ZERO);
    let usage = meter.drain();
    assert_eq!(usage.first().unwrap().day.to_string(), "2026-09-30");
}

#[test]
fn refuses_every_call_once_the_daily_hard_limit_is_reached() {
    let (_clock, meter) = meter(Some(2));

    assert_eq!(meter.reserve(Credits(1), Priority::Realtime), Ok(()));
    assert_eq!(meter.reserve(Credits(1), Priority::Realtime), Ok(()));
    let refusal = meter.reserve(Credits(1), Priority::Realtime).unwrap_err();

    let BudgetRefusal::DailyHardLimitReached { limit, resets_at } = refusal else {
        panic!("not the daily limit: {refusal:?}");
    };
    assert_eq!(limit, Credits(2));
    assert_eq!(resets_at.to_string(), "2026-09-22T00:00:00Z");
    assert_eq!(meter.spent_today(), Credits(2));
}

#[test]
fn keeps_the_guard_across_a_restart_once_seeded() {
    let (_clock, meter) = meter(Some(5));

    meter.seed(Credits(5), Credits(5));

    assert!(meter.reserve(Credits(1), Priority::Realtime).is_err());
}

#[test]
fn starts_each_utc_day_with_nothing_spent() {
    let (clock, meter) = meter(Some(1));
    meter.reserve(Credits(1), Priority::Realtime).unwrap();
    assert!(meter.reserve(Credits(1), Priority::Realtime).is_err());

    clock.advance(SignedDuration::from_hours(13)).unwrap();

    assert_eq!(meter.spent_today(), Credits::ZERO);
    assert_eq!(meter.reserve(Credits(1), Priority::Realtime), Ok(()));
}

#[test]
fn refuses_everything_but_an_hourly_probe_once_the_provider_says_the_credits_are_used_up() {
    let (clock, meter) = meter(None);

    meter.provider_refused();
    let refused = meter.reserve(Credits(1), Priority::Realtime);
    clock.advance(SignedDuration::from_hours(1)).unwrap();
    let probe = booking(&meter);
    let method = BilledMethod::Rpc(RpcMethod::GetTransaction);
    meter.record(&probe, method, &context(), CallOutcome::Ok);

    assert!(matches!(
        refused,
        Err(BudgetRefusal::CycleQuotaSpent { .. })
    ));
    assert_eq!(meter.reserve(Credits(1), Priority::Realtime), Ok(()));
}
