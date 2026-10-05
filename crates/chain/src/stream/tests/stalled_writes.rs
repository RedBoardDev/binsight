//! A blocked socket cannot prevent shutdown, credit draining or subscription recovery.

use super::*;
use crate::test_support::StreamWrite;

#[tokio::test(start_paused = true)]
async fn interrupts_blocked_subscribe_ping_and_unsubscribe_writes_at_shutdown() {
    for kind in [
        StreamWrite::Subscribe,
        StreamWrite::Ping,
        StreamWrite::Unsubscribe,
    ] {
        let mut stream = RunningStream::start(None);
        if kind == StreamWrite::Subscribe {
            stream.connector.block_writes(kind);
        }
        stream.watch.watch(WALLET);
        if kind == StreamWrite::Subscribe {
            assert_eq!(stream.next_event().await, StreamEvent::Connected);
        } else {
            stream
                .skip_to(|event| matches!(event, StreamEvent::Subscribed { .. }))
                .await;
            stream.connector.block_writes(kind);
            match kind {
                StreamWrite::Ping => tokio::time::advance(Duration::from_secs(30)).await,
                StreamWrite::Unsubscribe => stream.watch.unwatch(WALLET),
                StreamWrite::Subscribe => {}
            }
        }
        tokio::task::yield_now().await;
        let rpc = stream.rpc.clone();
        stream.stop().await;
        let usages = rpc.credit_meter().drain();
        assert!(
            usages
                .iter()
                .any(|usage| usage.method == BilledMethod::StreamOpen)
        );
    }
}

#[tokio::test(start_paused = true)]
async fn reconnects_when_a_subscribe_write_times_out_without_shutdown() {
    let mut stream = RunningStream::start(None);
    stream.connector.block_writes(StreamWrite::Subscribe);
    stream.watch.watch(WALLET);
    assert_eq!(stream.next_event().await, StreamEvent::Connected);
    let started = tokio::time::Instant::now();
    let event = stream.next_event().await;
    assert!(matches!(
        event,
        StreamEvent::Disconnected {
            reason: DisconnectReason::ConnectionLost { .. }
        }
    ));
    assert_eq!(started.elapsed(), Duration::from_secs(10));
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn reconnects_when_pongs_arrive_but_a_subscription_ack_never_does() {
    let mut stream = RunningStream::start(None);
    stream.connector.withhold_subscription_acks();
    stream.watch.watch(WALLET);
    assert_eq!(stream.next_event().await, StreamEvent::Connected);
    assert_eq!(
        stream.next_event().await,
        StreamEvent::Disconnected {
            reason: DisconnectReason::SubscriptionUnanswered { wallet: WALLET }
        }
    );
    assert_eq!(stream.next_event().await, StreamEvent::Connected);
    assert_eq!(stream.connector.connections_opened(), 2);
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn slow_writes_for_many_wallets_do_not_postpone_ack_deadlines() {
    let mut stream = RunningStream::start(None);
    stream
        .connector
        .delay_writes(StreamWrite::Subscribe, Duration::from_secs(9));
    stream.connector.withhold_subscription_acks();
    stream.watch.watch(WALLET);
    stream.watch.watch(OTHER);
    assert_eq!(stream.next_event().await, StreamEvent::Connected);
    let started = tokio::time::Instant::now();
    assert!(matches!(
        stream.next_event().await,
        StreamEvent::Disconnected {
            reason: DisconnectReason::SubscriptionUnanswered { .. }
        }
    ));
    assert_eq!(started.elapsed(), Duration::from_secs(15));
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn stopped_stream_does_not_keep_a_connected_health_snapshot() {
    let mut stream = RunningStream::start(None);
    stream.watch.watch(WALLET);
    stream
        .skip_to(|event| matches!(event, StreamEvent::Subscribed { .. }))
        .await;
    let rpc = stream.rpc.clone();
    assert!(rpc.stream_snapshot().is_connected);
    stream.stop().await;
    assert_eq!(rpc.stream_snapshot(), StreamSnapshot::default());
}
