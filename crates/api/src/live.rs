//! `GET /api/v1/events`: the live event stream (Server-Sent Events).
//!
//! A protected route: only a signed-in owner can listen. Each message is a named SSE event whose
//! `data` is a JSON [`event::LiveEvent`]; the browser reconnects by itself after 5 seconds if the
//! connection drops. Streams are never compressed or buffered by proxies, and end when the server
//! shuts down. This module holds the handler; the sequence of events is built in `stream`.

mod event;
mod stream;

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderName;
use axum::response::IntoResponse;
use axum::response::sse::{Event, Sse};
use futures_util::StreamExt;

use crate::error::ErrorBody;
use crate::state::AppState;
pub(crate) use event::LiveEvent;
use stream::live_events;

/// How long a browser waits before reconnecting after the stream drops.
const RECONNECT_DELAY_MILLIS: u64 = 5_000;

/// Streams the live events of the server.
#[utoipa::path(
    get,
    path = "/api/v1/events",
    operation_id = "streamEvents",
    tag = "live",
    security(("session_cookie" = [])),
    responses(
        (status = 200,
            description = "A stream of Server-Sent Events. The `event:` name of each message \
                equals the `type` of its JSON `data`. `engine_status` comes first, then a \
                `heartbeat` every 15 seconds and the other events as they happen.",
            content_type = "text/event-stream",
            body = LiveEvent),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
    ),
)]
pub(crate) async fn stream_events(State(state): State<AppState>) -> impl IntoResponse {
    let mut is_first = true;
    let events = live_events(state.engine, state.clock, state.shutdown).map(move |event| {
        let message = to_sse_event(&event);
        let message = if is_first {
            message.retry(Duration::from_millis(RECONNECT_DELAY_MILLIS))
        } else {
            message
        };
        is_first = false;
        Ok::<Event, Infallible>(message)
    });
    // Reverse proxies such as nginx would otherwise hold the events back in their buffer.
    let no_proxy_buffering = (HeaderName::from_static("x-accel-buffering"), "no");
    ([no_proxy_buffering], Sse::new(events))
}

/// One SSE message: the event name and its JSON data.
fn to_sse_event(event: &LiveEvent) -> Event {
    let message = Event::default().event(event.name());
    match serde_json::to_string(event) {
        Ok(json) => message.data(json),
        // Serializing a timestamp and enums cannot fail; send the name alone if it ever does.
        Err(_) => message,
    }
}
