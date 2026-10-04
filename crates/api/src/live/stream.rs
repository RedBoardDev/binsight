//! The sequence of events one client receives.
//!
//! On connection the client first gets the engine's current status, so it knows the state
//! without waiting; then a heartbeat every [`HEARTBEAT_INTERVAL_SECS`] seconds, interleaved with
//! the engine's events as they happen. A client too slow to keep up skips the events it missed
//! and gets the current status again. The sequence ends when the server shuts down. This module
//! builds the sequence; turning it into SSE is the handler's job.
//!
//! The subscription to the engine's events is taken before the current status is read. The
//! engine records a new status before it publishes the event, so a change that lands while a
//! client connects is either already in the status read or delivered by the subscription; read
//! the other way round, a change in between would be lost until the next one.

use std::future::ready;
use std::sync::Arc;
use std::time::Duration;

use binsight_core::clock::Clock;
use binsight_engine::{EngineEvent, EngineHandle, EngineStatus};
use futures_util::stream::{self, Stream, StreamExt};
use tokio::sync::broadcast;
use tokio::time::{Instant, interval_at};
use tokio_stream::wrappers::{BroadcastStream, IntervalStream};
use tokio_util::sync::CancellationToken;

use super::event::LiveEvent;

/// How often a heartbeat is sent.
pub(crate) const HEARTBEAT_INTERVAL_SECS: u64 = 15;

/// What the live stream reads from the engine.
///
/// [`EngineHandle`] is the real one; the tests use a double that changes the status at the worst
/// possible moment.
pub(crate) trait EngineFeed: Send + 'static {
    /// Starts receiving the events published from now on.
    fn subscribe(&self) -> broadcast::Receiver<EngineEvent>;
    /// The current lifecycle status.
    fn status(&self) -> EngineStatus;
}

impl EngineFeed for EngineHandle {
    fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        EngineHandle::subscribe(self)
    }

    fn status(&self) -> EngineStatus {
        EngineHandle::status(self)
    }
}

/// The events for one client, until `shutdown` is cancelled.
pub(crate) fn live_events(
    engine: impl EngineFeed,
    clock: Arc<dyn Clock>,
    shutdown: CancellationToken,
) -> impl Stream<Item = LiveEvent> + Send + 'static {
    // First the subscription, then the status: see the module documentation.
    let subscription = BroadcastStream::new(engine.subscribe());
    let current_status = stream::once(ready(current_status_event(&engine)));
    let engine_events = subscription.map(move |received| {
        received.map_or_else(|_lagged| current_status_event(&engine), LiveEvent::from)
    });
    current_status
        .chain(stream::select(heartbeats(clock), engine_events))
        .take_until(shutdown.cancelled_owned())
}

fn current_status_event(engine: &impl EngineFeed) -> LiveEvent {
    LiveEvent::EngineStatus {
        status: engine.status().into(),
    }
}

/// A heartbeat every interval, the first one an interval after connecting.
fn heartbeats(clock: Arc<dyn Clock>) -> impl Stream<Item = LiveEvent> + Send + 'static {
    let period = Duration::from_secs(HEARTBEAT_INTERVAL_SECS);
    IntervalStream::new(interval_at(Instant::now() + period, period)).map(move |_| {
        LiveEvent::Heartbeat {
            server_time: clock.now(),
        }
    })
}

#[cfg(test)]
mod tests {
    use binsight_core::clock::FixedClock;
    use jiff::Timestamp;

    use super::*;
    use crate::health;

    /// An engine whose status changes right after it is read, before anything else happens.
    struct ChangingRightAfterTheRead {
        events: broadcast::Sender<EngineEvent>,
    }

    impl EngineFeed for ChangingRightAfterTheRead {
        fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
            self.events.subscribe()
        }

        fn status(&self) -> EngineStatus {
            let _ = self.events.send(EngineEvent::StatusChanged {
                status: EngineStatus::Running,
            });
            EngineStatus::Starting
        }
    }

    // Paused time: if the change were lost, the next message would be a heartbeat, at once.
    #[tokio::test(start_paused = true)]
    async fn never_loses_a_status_change_made_while_the_client_connects() {
        let (events, _) = broadcast::channel(8);
        let clock = Arc::new(FixedClock::new(Timestamp::UNIX_EPOCH));

        let stream = live_events(
            ChangingRightAfterTheRead { events },
            clock,
            CancellationToken::new(),
        );
        let first_two: Vec<LiveEvent> = stream.take(2).collect().await;

        assert_eq!(
            first_two,
            vec![
                LiveEvent::EngineStatus {
                    status: health::EngineStatus::Starting
                },
                LiveEvent::EngineStatus {
                    status: health::EngineStatus::Running
                },
            ]
        );
    }
}
