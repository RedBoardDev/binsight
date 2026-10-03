//! The sequence of events one client receives.
//!
//! On connection the client first gets the engine's current status, so it knows the state
//! without waiting; then a heartbeat every [`HEARTBEAT_INTERVAL_SECS`] seconds, interleaved with
//! the engine's events as they happen. A client too slow to keep up skips the events it missed
//! and gets the current status again. The sequence ends when the server shuts down. This module
//! builds the sequence; turning it into SSE is the handler's job.

use std::future::ready;
use std::sync::Arc;
use std::time::Duration;

use binsight_core::clock::Clock;
use binsight_engine::EngineHandle;
use futures_util::stream::{self, Stream, StreamExt};
use tokio::time::{Instant, interval_at};
use tokio_stream::wrappers::{BroadcastStream, IntervalStream};
use tokio_util::sync::CancellationToken;

use super::event::LiveEvent;

/// How often a heartbeat is sent.
pub(crate) const HEARTBEAT_INTERVAL_SECS: u64 = 15;

/// The events for one client, until `shutdown` is cancelled.
pub(crate) fn live_events(
    engine: EngineHandle,
    clock: Arc<dyn Clock>,
    shutdown: CancellationToken,
) -> impl Stream<Item = LiveEvent> + Send + 'static {
    let current_status = stream::once(ready(current_status_event(&engine)));
    let heartbeats = heartbeats(clock);
    let engine_events = BroadcastStream::new(engine.subscribe()).map(move |received| {
        received.map_or_else(|_lagged| current_status_event(&engine), LiveEvent::from)
    });
    current_status
        .chain(stream::select(heartbeats, engine_events))
        .take_until(shutdown.cancelled_owned())
}

fn current_status_event(engine: &EngineHandle) -> LiveEvent {
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
