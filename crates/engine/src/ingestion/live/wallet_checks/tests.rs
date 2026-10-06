//! When each kind of check falls due, and how the stream and listings move them.

use super::*;

fn start() -> Timestamp {
    Timestamp::from_second(1_790_000_000).unwrap()
}

fn at(secs: i64) -> Timestamp {
    later(start(), SignedDuration::from_secs(secs))
}

/// The check due first.
fn first_due(checks: &WalletChecks) -> (Timestamp, CheckReason) {
    checks.due(start()).into_iter().min().unwrap()
}

/// A wallet subscribed and checked at startup.
fn checked_at_startup() -> WalletChecks {
    let mut checks = WalletChecks::default();
    checks.subscribed(at(0));
    checks.checked(at(0));
    checks
}

#[test]
fn checks_a_bursting_wallet_with_one_listing() {
    let mut checks = checked_at_startup();

    for second in [100, 105, 110, 115, 120] {
        checks.activity(at(second));
    }

    assert_eq!(first_due(&checks), (at(150), CheckReason::Activity));
    checks.checked(at(150));
    assert_eq!(first_due(&checks), (at(1_050), CheckReason::Cadence));
}

#[test]
fn checks_a_wallet_that_never_stops_two_minutes_after_its_first_activity() {
    let mut checks = checked_at_startup();

    for second in (100..=300).step_by(10) {
        checks.activity(at(second));
    }

    assert_eq!(first_due(&checks), (at(220), CheckReason::Activity));
}

#[test]
fn checks_a_busy_wallet_at_most_once_a_minute() {
    let mut checks = checked_at_startup();
    checks.activity(at(10));
    checks.checked(at(40));

    checks.activity(at(45));

    assert_eq!(first_due(&checks), (at(100), CheckReason::Activity));
}

#[test]
fn keeps_an_activity_a_too_early_check_could_not_cover() {
    let mut checks = WalletChecks::default();
    checks.subscribed(at(0));
    checks.activity(at(1));

    checks.checked(at(2));

    assert_eq!(first_due(&checks), (at(62), CheckReason::Activity));
}

#[test]
fn checks_every_minute_while_unsubscribed() {
    let mut checks = checked_at_startup();

    checks.unsubscribed(at(1));

    assert_eq!(first_due(&checks), (at(60), CheckReason::Cadence));
}

#[test]
fn holds_a_failing_check_back_longer_after_each_failure() {
    let mut checks = WalletChecks::default();
    checks.subscribed(at(0));

    assert_eq!(checks.failed(at(0)), (1, at(30)));
    assert_eq!(first_due(&checks), (at(30), CheckReason::TopUp));
    assert_eq!(checks.failed(at(30)), (2, at(90)));
    checks.checked(at(90));
    assert_eq!(checks.failed(at(100)), (1, at(130)));
}

#[test]
fn tells_since_when_a_subscription_is_down_and_when_a_check_gets_late() {
    let mut checks = WalletChecks::default();
    let lag = checks.lag(start());
    assert_eq!(
        (lag.unsubscribed_since, lag.late_after),
        (Some(start()), None)
    );
    checks.subscribed(at(1));
    checks.checked(at(1));
    let lag = checks.lag(start());
    assert_eq!(
        (lag.unsubscribed_since, lag.late_after),
        (None, Some(at(1_801)))
    );

    checks.unsubscribed(at(1_900));

    let lag = checks.lag(start());
    assert_eq!(lag.unsubscribed_since, Some(at(1_900)));
    assert_eq!(lag.late_after, Some(at(121)));
}
