//! How the stream recovers: from a dead connection, a dropped one, a refused one, and a credit
//! limit that keeps it closed.

use std::time::Duration;

use super::*;

#[tokio::test(start_paused = true)]
async fn reconnects_after_an_unanswered_ping() {
    let mut stream = RunningStream::start(None);
    stream.watch.watch(WALLET);
    stream
        .skip_to(|event| matches!(event, StreamEvent::Subscribed { .. }))
        .await;
    let started = tokio::time::Instant::now();

    stream.connector.ignore_pings();

    assert_eq!(
        stream.next_event().await,
        StreamEvent::Disconnected {
            reason: DisconnectReason::Unanswered
        }
    );
    assert_eq!(started.elapsed(), Duration::from_secs(45));
    assert_eq!(stream.next_event().await, StreamEvent::Connected);
    assert_eq!(stream.connector.connections_opened(), 2);
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn resubscribes_every_wallet_after_a_reconnect() {
    let mut stream = RunningStream::start(None);
    stream.watch.watch(WALLET);
    stream
        .skip_to(|event| matches!(event, StreamEvent::Subscribed { .. }))
        .await;

    stream.connector.drop_connection();

    assert!(matches!(
        stream.next_event().await,
        StreamEvent::Disconnected {
            reason: DisconnectReason::ConnectionLost { .. }
        }
    ));
    assert_eq!(stream.next_event().await, StreamEvent::Connected);
    assert_eq!(
        stream.next_event().await,
        StreamEvent::Subscribed { wallet: WALLET }
    );
    assert!(stream.connector.is_subscribed(WALLET));
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn tries_again_after_a_refused_connection() {
    let mut stream = RunningStream::start(None);
    stream
        .connector
        .refuse_next_connection("connection refused");

    stream.watch.watch(WALLET);

    assert!(matches!(
        stream.next_event().await,
        StreamEvent::Disconnected {
            reason: DisconnectReason::ConnectFailed { .. }
        }
    ));
    assert_eq!(stream.next_event().await, StreamEvent::Connected);
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn closes_the_stream_once_the_daily_limit_is_reached() {
    let mut stream = RunningStream::start(Some(3));

    stream.watch.watch(WALLET);

    assert_eq!(stream.next_event().await, StreamEvent::Connected);
    assert_eq!(
        stream.next_event().await,
        StreamEvent::Disconnected {
            reason: DisconnectReason::BudgetRefused
        }
    );
    tokio::time::sleep(Duration::from_hours(2)).await;
    assert_eq!(stream.connector.connections_opened(), 1);
    assert!(stream.events.try_recv().is_err());
    stream.stop().await;
}
