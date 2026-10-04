//! The stream's behaviour end to end, against the scripted connector on paused time: what it
//! opens, subscribes, reports, bills and recovers from.

use std::sync::Arc;
use std::time::Duration;

use binsight_core::clock::FixedClock;
use binsight_core::credits::{Credits, Purpose};
use binsight_solana::{Address, Signature};
use jiff::Timestamp;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::*;
use crate::governor::BilledMethod;
use crate::test_support::{ScriptedConnector, ScriptedTransport, scripted_client};

mod recovery;

const WALLET: Address = Address::from_bytes([1; 32]);
const OTHER: Address = Address::from_bytes([2; 32]);

/// How long a test waits for an event, on paused time, before failing.
const PATIENCE: Duration = Duration::from_hours(1);

/// A stream running in the background on a scripted connector.
struct RunningStream {
    connector: Arc<ScriptedConnector>,
    watch: WalletWatch,
    events: mpsc::Receiver<StreamEvent>,
    rpc: RpcClient,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl RunningStream {
    fn start(daily_limit: Option<u64>) -> Self {
        let connector = ScriptedConnector::new();
        let clock = Arc::new(FixedClock::new(
            Timestamp::from_second(1_790_000_000).unwrap(),
        ));
        let rpc = scripted_client(ScriptedTransport::new(), clock, daily_limit.map(Credits));
        let (stream, watch, events) = WalletStream::new(connector.clone(), rpc.clone());
        let (stop, stopped) = oneshot::channel::<()>();
        let task = tokio::spawn(stream.run(async {
            let _ = stopped.await;
        }));
        Self {
            connector,
            watch,
            events,
            rpc,
            stop,
            task,
        }
    }

    async fn next_event(&mut self) -> StreamEvent {
        tokio::time::timeout(PATIENCE, self.events.recv())
            .await
            .expect("no event came")
            .expect("the stream stopped")
    }

    async fn skip_to(&mut self, wanted: impl Fn(&StreamEvent) -> bool) -> StreamEvent {
        loop {
            let event = self.next_event().await;
            if wanted(&event) {
                return event;
            }
        }
    }

    /// The `(calls, credits)` counted for each billed method since the last look.
    fn bills(&self) -> Vec<(BilledMethod, u64, Credits)> {
        let mut bills: Vec<(BilledMethod, u64, Credits)> = Vec::new();
        for usage in self.rpc.credit_meter().drain() {
            assert_eq!(usage.purpose, Purpose::LiveStream);
            match bills
                .iter_mut()
                .find(|(method, _, _)| *method == usage.method)
            {
                Some((_, calls, credits)) => {
                    *calls += usage.calls;
                    *credits = credits.saturating_add(usage.credits);
                }
                None => bills.push((usage.method, usage.calls, usage.credits)),
            }
        }
        bills.sort();
        bills
    }

    async fn stop(self) {
        self.stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), self.task)
            .await
            .expect("the stream did not stop in time")
            .unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn opens_nothing_while_no_wallet_is_watched() {
    let stream = RunningStream::start(None);

    tokio::time::sleep(Duration::from_secs(600)).await;

    assert_eq!(stream.connector.connections_opened(), 0);
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn subscribes_every_watched_wallet_once_connected() {
    let mut stream = RunningStream::start(None);

    stream.watch.watch(WALLET);
    stream.watch.watch(OTHER);

    assert_eq!(stream.next_event().await, StreamEvent::Connected);
    let mut subscribed = [stream.next_event().await, stream.next_event().await];
    subscribed.sort_by_key(|event| format!("{event:?}"));
    assert_eq!(
        subscribed,
        [
            StreamEvent::Subscribed { wallet: WALLET },
            StreamEvent::Subscribed { wallet: OTHER }
        ]
    );
    let subscriptions = stream
        .connector
        .sent_frames()
        .iter()
        .filter(|frame| frame.contains("logsSubscribe"))
        .count();
    assert_eq!(subscriptions, 2);
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn reports_each_signature_once_per_wallet_failed_ones_included() {
    let mut stream = RunningStream::start(None);
    stream.watch.watch(WALLET);
    stream
        .skip_to(|event| matches!(event, StreamEvent::Subscribed { .. }))
        .await;
    let signature = Signature::from_bytes([7; 64]);

    stream.connector.notify(WALLET, signature, 300, true);
    stream.connector.notify(WALLET, signature, 300, true);

    let activity = Activity {
        wallet: WALLET,
        signature,
        slot: 300,
        is_failed: true,
    };
    assert_eq!(stream.next_event().await, StreamEvent::Activity(activity));
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(stream.events.try_recv().is_err());
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn reports_a_refused_subscription_instead_of_staying_silent() {
    let mut stream = RunningStream::start(None);
    stream
        .connector
        .refuse_subscriptions(-32_600, "not available on this plan");

    stream.watch.watch(WALLET);

    let refused = stream
        .skip_to(|event| !matches!(event, StreamEvent::Connected))
        .await;
    assert_eq!(
        refused,
        StreamEvent::SubscriptionRefused {
            wallet: WALLET,
            code: -32_600,
            message: "not available on this plan".to_owned()
        }
    );
    stream.connector.accept_subscriptions();
    let started = tokio::time::Instant::now();
    assert_eq!(
        stream.next_event().await,
        StreamEvent::Subscribed { wallet: WALLET }
    );
    assert!(started.elapsed() >= Duration::from_secs(299));
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn releases_an_unwatched_wallet_and_closes_once_none_is_left() {
    let mut stream = RunningStream::start(None);
    stream.watch.watch(WALLET);
    stream
        .skip_to(|event| matches!(event, StreamEvent::Subscribed { .. }))
        .await;

    stream.watch.unwatch(WALLET);

    assert_eq!(
        stream.next_event().await,
        StreamEvent::Disconnected {
            reason: DisconnectReason::NothingToWatch
        }
    );
    let frames = stream.connector.sent_frames();
    assert!(frames.iter().any(|frame| frame.contains("logsUnsubscribe")));
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(stream.connector.connections_opened(), 1);
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn bills_the_opening_and_every_started_tenth_of_a_megabyte() {
    let mut stream = RunningStream::start(None);
    stream.watch.watch(WALLET);
    stream
        .skip_to(|event| matches!(event, StreamEvent::Subscribed { .. }))
        .await;

    stream.connector.push_text(&"x".repeat(150_000));
    tokio::time::sleep(Duration::from_secs(1)).await;

    assert_eq!(
        stream.bills(),
        [
            (BilledMethod::StreamOpen, 1, Credits(1)),
            (BilledMethod::StreamData, 2, Credits(4))
        ]
    );
    stream.stop().await;
}

#[tokio::test(start_paused = true)]
async fn reports_an_error_frame_that_answers_nothing() {
    let mut stream = RunningStream::start(None);
    stream.watch.watch(WALLET);
    stream
        .skip_to(|event| matches!(event, StreamEvent::Subscribed { .. }))
        .await;

    stream
        .connector
        .push_text(r#"{"jsonrpc":"2.0","error":{"code":-32603,"message":"internal"}}"#);

    assert_eq!(
        stream.next_event().await,
        StreamEvent::ServerError {
            code: -32_603,
            message: "internal".to_owned()
        }
    );
    stream.stop().await;
}
