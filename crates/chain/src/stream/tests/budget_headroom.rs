//! Opening credits and data headroom share the same hard budget as concurrent RPC calls.

use super::*;
use crate::rpc::CallContext;
use binsight_core::clock::Clock;
use binsight_core::credits::{CallOutcome, Priority};

#[tokio::test(start_paused = true)]
async fn a_stream_handshake_does_not_spend_or_replace_the_hourly_rpc_probe() {
    let mut stream = RunningStream::start(None);
    stream.connector.withhold_subscription_acks();
    stream.rpc.governor().credits_exhausted();
    stream
        .clock
        .advance(jiff::SignedDuration::from_hours(1))
        .unwrap();
    let probe_at = stream.clock.now();
    stream.watch.watch(WALLET);

    assert_eq!(
        stream.next_event().await,
        StreamEvent::Disconnected {
            reason: DisconnectReason::BudgetRefused
        }
    );
    assert_eq!(stream.connector.connections_opened(), 0);
    assert_eq!(
        stream.rpc.credit_meter().standing().spent_today,
        Credits::ZERO
    );
    tokio::time::advance(Duration::from_secs(300)).await;
    assert_eq!(stream.connector.connections_opened(), 0);
    let probe = stream
        .rpc
        .governor()
        .admit(
            crate::RpcMethod::GetTransaction,
            CallContext {
                priority: Priority::Realtime,
                purpose: Purpose::TransactionFetch,
                wallet: None,
            },
        )
        .await
        .unwrap();
    for _ in 0..3 {
        tokio::task::yield_now().await;
    }
    assert_eq!(stream.connector.connections_opened(), 0);
    assert_eq!(stream.rpc.credit_meter().standing().spent_today, Credits(1));
    probe.settle(CallOutcome::Ok);
    stream
        .skip_to(|event| matches!(event, StreamEvent::Connected))
        .await;
    assert_eq!(stream.connector.connections_opened(), 1);
    assert_eq!(stream.rpc.credit_meter().standing().spent_today, Credits(2));
    assert_eq!(stream.clock.now(), probe_at);
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn provider_refusal_closes_an_open_stream_even_when_an_rpc_probe_is_due() {
    let mut stream = RunningStream::start(None);
    stream.connector.withhold_subscription_acks();
    stream.watch.watch(WALLET);
    assert_eq!(stream.next_event().await, StreamEvent::Connected);
    stream.rpc.governor().credits_exhausted();
    stream
        .clock
        .advance(jiff::SignedDuration::from_hours(1))
        .unwrap();

    assert_eq!(
        stream.next_event().await,
        StreamEvent::Disconnected {
            reason: DisconnectReason::BudgetRefused
        }
    );
    assert_eq!(stream.connector.connections_opened(), 1);
    assert_eq!(stream.rpc.credit_meter().standing().spent_today, Credits(1));
    assert_eq!(
        stream.bills(),
        vec![(BilledMethod::StreamOpen, 1, Credits(1))]
    );
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn refuses_to_open_with_less_than_three_credits_available() {
    for remaining in 0..3 {
        let mut stream = RunningStream::start(Some(remaining));
        stream.watch.watch(WALLET);
        assert_eq!(
            stream.next_event().await,
            StreamEvent::Disconnected {
                reason: DisconnectReason::BudgetRefused
            }
        );
        assert_eq!(stream.connector.connections_opened(), 0);
        assert_eq!(
            stream.rpc.credit_meter().standing().spent_today,
            Credits::ZERO
        );
        stream.stop().await;
    }
}

#[tokio::test(start_paused = true)]
async fn allows_three_credits_and_counts_a_large_received_frame_in_full() {
    let mut stream = RunningStream::start(Some(5));
    stream.watch.watch(WALLET);
    stream
        .skip_to(|event| matches!(event, StreamEvent::Subscribed { .. }))
        .await;
    stream.connector.push_text(&"x".repeat(250_000));
    stream
        .skip_to(|event| {
            matches!(
                event,
                StreamEvent::Disconnected {
                    reason: DisconnectReason::BudgetRefused
                }
            )
        })
        .await;
    assert_eq!(stream.rpc.credit_meter().standing().spent_today, Credits(7));
    assert_eq!(
        stream.bills(),
        vec![
            (BilledMethod::StreamOpen, 1, Credits(1)),
            (BilledMethod::StreamData, 3, Credits(6))
        ]
    );
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn held_headroom_wakes_every_waiter_and_cancellation_spends_nothing() {
    let mut stream = RunningStream::start(Some(3));
    stream.connector.withhold_subscription_acks();
    stream.watch.watch(WALLET);
    assert_eq!(stream.next_event().await, StreamEvent::Connected);
    let context = CallContext {
        priority: Priority::Realtime,
        purpose: Purpose::TransactionFetch,
        wallet: None,
    };
    let mut waiters = Vec::new();
    for _ in 0..3 {
        let rpc = stream.rpc.clone();
        waiters.push(tokio::spawn(async move {
            rpc.governor()
                .admit(crate::RpcMethod::GetTransaction, context)
                .await?
                .settle(CallOutcome::Ok);
            Ok::<(), crate::BudgetRefusal>(())
        }));
    }
    for _ in 0..5 {
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(100)).await;
    }
    assert_eq!(stream.rpc.credit_meter().headroom_waiters(), 3);
    for waiter in &waiters {
        assert!(!waiter.is_finished());
    }
    assert_eq!(stream.rpc.credit_meter().standing().spent_today, Credits(1));
    let cancelled = waiters.pop().unwrap();
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    let rpc = stream.rpc.clone();
    stream.stop().await;
    for waiter in waiters {
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
    let usage = rpc.credit_meter().drain();
    assert!(usage.iter().all(|usage| usage.outcome == CallOutcome::Ok));
    assert_eq!(usage.iter().map(|usage| usage.calls).sum::<u64>(), 3);
    assert_eq!(rpc.credit_meter().standing().spent_today, Credits(3));
}

#[tokio::test(start_paused = true)]
async fn a_failed_open_releases_headroom_for_waiting_rpc_without_advancing_the_day() {
    let mut stream = RunningStream::start(Some(3));
    stream.connector.block_connections();
    stream.watch.watch(WALLET);
    for _ in 0..10 {
        if stream.rpc.credit_meter().standing().spent_today == Credits(1) {
            break;
        }
        tokio::task::yield_now().await;
    }
    let rpc = stream.rpc.clone();
    let day = rpc.credit_meter().cycle_first_day();
    let caller_rpc = rpc.clone();
    let waiter = tokio::spawn(async move {
        caller_rpc
            .governor()
            .admit(
                crate::RpcMethod::GetTransaction,
                CallContext {
                    priority: Priority::Realtime,
                    purpose: Purpose::TransactionFetch,
                    wallet: None,
                },
            )
            .await?
            .settle(CallOutcome::Ok);
        Ok::<(), crate::BudgetRefusal>(())
    });
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(!waiter.is_finished());
    assert!(matches!(
        stream.next_event().await,
        StreamEvent::Disconnected {
            reason: DisconnectReason::ConnectFailed { .. }
        }
    ));
    tokio::time::timeout(Duration::from_secs(1), waiter)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(rpc.credit_meter().standing().spent_today, Credits(2));
    assert_eq!(rpc.credit_meter().cycle_first_day(), day);
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn opens_with_exactly_three_credits_and_resumes_after_midnight() {
    let mut stream = RunningStream::start(Some(3));
    stream.rpc.credit_meter().seed(Credits(3), Credits(3));
    stream.watch.watch(WALLET);
    assert_eq!(
        stream.next_event().await,
        StreamEvent::Disconnected {
            reason: DisconnectReason::BudgetRefused
        }
    );
    stream
        .clock
        .advance(jiff::SignedDuration::from_hours(24))
        .unwrap();
    tokio::time::advance(Duration::from_hours(24)).await;
    stream
        .skip_to(|event| matches!(event, StreamEvent::Connected))
        .await;
    stream
        .skip_to(|event| {
            matches!(
                event,
                StreamEvent::Disconnected {
                    reason: DisconnectReason::BudgetRefused
                }
            )
        })
        .await;
    assert_eq!(stream.rpc.credit_meter().standing().spent_today, Credits(3));
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn aborting_the_whole_worker_counts_a_pending_open_and_releases_headroom() {
    let stream = RunningStream::start(Some(3));
    stream.connector.block_connections();
    stream.watch.watch(WALLET);
    for _ in 0..10 {
        if stream.rpc.credit_meter().standing().spent_today == Credits(1) {
            break;
        }
        tokio::task::yield_now().await;
    }
    let rpc = stream.rpc.clone();
    assert_eq!(rpc.credit_meter().standing().spent_today, Credits(1));
    stream.task.abort();
    assert!(stream.task.await.unwrap_err().is_cancelled());
    let usage = rpc.credit_meter().drain();
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0].method, BilledMethod::StreamOpen);
    assert_eq!(usage[0].outcome, CallOutcome::Cancelled);
    assert_eq!(usage[0].credits, Credits(1));
    assert_eq!(rpc.stream_snapshot(), StreamSnapshot::default());
    assert!(
        rpc.governor()
            .admit(
                crate::RpcMethod::GetTransaction,
                CallContext {
                    priority: Priority::Realtime,
                    purpose: Purpose::TransactionFetch,
                    wallet: None
                }
            )
            .await
            .is_ok()
    );
}
