//! Keeping one stream connection open for as long as a wallet is watched.
//!
//! The supervisor opens a connection only when there is something to watch, after the budget
//! admits the opening (one credit), runs a session on it, and when it ends reports why, waits a
//! backoff and opens another; a hard credit limit keeps it closed until the limit resets. Watch
//! commands are applied at all times, connected or not. Events go out through a bounded channel:
//! if the engine falls behind, the events that do not fit are dropped and an `Overflowed` marker
//! follows, so the engine lists every wallet again instead of trusting a stream with holes. With
//! no wallet watched, nothing is ever opened.

use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use binsight_core::credits::CallOutcome;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio::time::{Instant, timeout};
use tracing::{debug, info, warn};

use super::recent_signatures::RecentSignatures;
use super::reconnect_backoff::ReconnectBackoff;
use super::session::{SessionEnd, run_session};
use super::stream_events::{DisconnectReason, StreamCommand, StreamEvent, StreamSnapshot};
use super::subscriptions::Subscriptions;
use super::ws_connection::WsConnector;
use crate::error::BudgetRefusal;
use crate::rpc::RpcClient;

/// Keeps separate streams on one process from reconnecting in step under the same clock.
static STREAM_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// How long opening a connection may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The engine's events, sent without ever blocking the stream.
#[derive(Debug)]
pub(super) struct EventOutbox {
    events: mpsc::Sender<StreamEvent>,
    has_overflowed: bool,
    owes_snapshot: bool,
    snapshot: StreamSnapshot,
    rpc: RpcClient,
}

impl EventOutbox {
    pub(super) fn new(events: mpsc::Sender<StreamEvent>, rpc: RpcClient) -> Self {
        Self {
            events,
            has_overflowed: false,
            owes_snapshot: false,
            snapshot: StreamSnapshot::default(),
            rpc,
        }
    }

    /// Sends `event`, or drops it and remembers to send `Overflowed` if the engine is behind.
    pub(super) fn send(&mut self, event: StreamEvent) {
        self.snapshot.apply(&event);
        self.rpc.publish_stream(self.snapshot.clone());
        self.flush_overflow();
        if self.has_overflowed || self.owes_snapshot {
            return;
        }
        if let Err(TrySendError::Full(_)) = self.events.try_send(event) {
            warn!("the engine falls behind the stream; its events are dropped until it catches up");
            self.has_overflowed = true;
        }
    }

    /// Sends the `Overflowed` marker owed, if there is room now.
    pub(super) fn flush_overflow(&mut self) {
        if self.has_overflowed && self.events.try_send(StreamEvent::Overflowed).is_ok() {
            self.has_overflowed = false;
            self.owes_snapshot = true;
        }
        if self.owes_snapshot
            && self
                .events
                .try_send(StreamEvent::Reconciled(self.snapshot.clone()))
                .is_ok()
        {
            self.owes_snapshot = false;
        }
    }

    /// Wakes when an owed marker or snapshot can be delivered, even without another frame.
    pub(super) async fn room_for_reconciliation(&self) {
        if !(self.has_overflowed || self.owes_snapshot) {
            return std::future::pending().await;
        }
        match self.events.reserve().await {
            Ok(permit) => drop(permit),
            Err(_) => std::future::pending().await,
        }
    }

    pub(super) fn watched(&mut self, wallet: binsight_solana::Address) {
        self.snapshot.watched.insert(wallet);
        self.rpc.publish_stream(self.snapshot.clone());
    }

    pub(super) fn unwatched(&mut self, wallet: binsight_solana::Address) {
        self.snapshot.subscriptions.remove(&wallet);
        self.snapshot.watched.remove(&wallet);
        self.rpc.publish_stream(self.snapshot.clone());
    }
}

impl Drop for EventOutbox {
    fn drop(&mut self) {
        self.rpc.publish_stream(StreamSnapshot::default());
    }
}

/// Unused streamed-data headroom is released even if the entire stream future is cancelled.
struct StreamAdmission {
    rpc: RpcClient,
    booking: Option<crate::governor::CreditBooking>,
}

impl StreamAdmission {
    fn settle(&mut self, outcome: CallOutcome) {
        if let Some(booking) = self.booking.take() {
            self.rpc.governor().record_stream_open(&booking, outcome);
        }
    }
}

impl Drop for StreamAdmission {
    fn drop(&mut self) {
        self.settle(CallOutcome::Cancelled);
        self.rpc.governor().stream_ended();
    }
}

/// What the supervisor keeps across connections.
pub(super) struct Supervision {
    pub(super) rpc: RpcClient,
    pub(super) subscriptions: Subscriptions,
    pub(super) recent: RecentSignatures,
    pub(super) outbox: EventOutbox,
    pub(super) commands: mpsc::UnboundedReceiver<StreamCommand>,
}

impl Supervision {
    fn obey(&mut self, command: StreamCommand) {
        match command {
            StreamCommand::Watch(wallet) => {
                self.subscriptions.watch(wallet);
                self.outbox.watched(wallet);
            }
            StreamCommand::Unwatch(wallet) => {
                self.subscriptions.unwatch(wallet);
                self.outbox.unwatched(wallet);
            }
        }
    }
}

/// Runs the stream until `shutdown` completes.
pub(super) async fn supervise(
    connector: Arc<dyn WsConnector>,
    mut supervision: Supervision,
    shutdown: impl Future<Output = ()>,
) {
    let mut shutdown = pin!(shutdown);
    let seed = u64::try_from(supervision.rpc.governor().now().as_nanosecond()).unwrap_or_default()
        ^ STREAM_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut backoff = ReconnectBackoff::new(seed);
    let mut is_refusal_reported = false;
    loop {
        if supervision.subscriptions.is_empty() {
            if !wait(None, &mut supervision, &mut shutdown).await {
                return;
            }
            continue;
        }
        let opening_day = match supervision.rpc.governor().admit_stream_open() {
            Ok(day) => day,
            Err(refusal) => {
                if !is_refusal_reported {
                    report_budget_refusal(&refusal, &mut supervision);
                    is_refusal_reported = true;
                }
                let pause = time_until(&supervision, refusal.resume_at());
                let rpc = supervision.rpc.clone();
                let should_retry = tokio::select! {
                    () = rpc.credit_meter().changed() => true,
                    should_retry = wait(Some(pause), &mut supervision, &mut shutdown) => should_retry,
                };
                if !should_retry {
                    return;
                }
                continue;
            }
        };
        let mut admission = StreamAdmission {
            rpc: supervision.rpc.clone(),
            booking: Some(opening_day),
        };
        let result =
            connect_and_run(&*connector, &mut supervision, &mut shutdown, &mut admission).await;
        drop(admission);
        let Some((lasted, reason)) = result else {
            return;
        };
        is_refusal_reported = reason == DisconnectReason::BudgetRefused;
        disconnected(&mut supervision, reason);
        supervision.subscriptions.disconnected();
        if !wait(Some(backoff.after(lasted)), &mut supervision, &mut shutdown).await {
            return;
        }
    }
}

/// Opens a connection and runs a session on it; returns how long it lasted and why it ended, or
/// `None` at shutdown.
async fn connect_and_run(
    connector: &dyn WsConnector,
    supervision: &mut Supervision,
    shutdown: &mut (impl Future<Output = ()> + Unpin),
    admission: &mut StreamAdmission,
) -> Option<(Duration, DisconnectReason)> {
    let opened = tokio::select! {
        () = &mut *shutdown => {
            admission.settle(CallOutcome::Cancelled);
            return None;
        }
        opened = timeout(CONNECT_TIMEOUT, connector.connect()) => opened,
    };
    let mut connection = match opened {
        Ok(Ok(connection)) => {
            admission.settle(CallOutcome::Ok);
            connection
        }
        Ok(Err(error)) => {
            admission.settle(CallOutcome::NetworkError);
            let detail = error.to_string();
            return Some((Duration::ZERO, DisconnectReason::ConnectFailed { detail }));
        }
        Err(_elapsed) => {
            admission.settle(CallOutcome::Timeout);
            let detail = "the connection did not open in time".to_owned();
            return Some((Duration::ZERO, DisconnectReason::ConnectFailed { detail }));
        }
    };
    info!("stream connected");
    supervision.outbox.send(StreamEvent::Connected);
    let started = Instant::now();
    let ended = run_session(connection.as_mut(), supervision, shutdown).await;
    match ended {
        SessionEnd::Shutdown => None,
        SessionEnd::Lost(reason) => Some((started.elapsed(), reason)),
    }
}

/// Reports the end of a connection, or of an attempt to open one.
fn disconnected(supervision: &mut Supervision, reason: DisconnectReason) {
    match &reason {
        DisconnectReason::NothingToWatch => debug!("stream closed: no wallet to watch"),
        other => warn!(reason = ?other, "stream disconnected; reconnecting after a backoff"),
    }
    supervision
        .outbox
        .send(StreamEvent::Disconnected { reason });
}

/// Reports that the budget keeps the stream closed.
fn report_budget_refusal(refusal: &BudgetRefusal, supervision: &mut Supervision) {
    warn!(%refusal, "the stream stays closed until the credit limit resets");
    supervision.outbox.send(StreamEvent::Disconnected {
        reason: DisconnectReason::BudgetRefused,
    });
}

/// How long from now until `until`, on the client's clock.
fn time_until(supervision: &Supervision, until: jiff::Timestamp) -> Duration {
    let now = supervision.rpc.governor().now();
    Duration::try_from(until.duration_since(now)).unwrap_or(Duration::ZERO)
}

/// Waits `pause` (forever if `None`) or until a command changes what is watched, applying the
/// commands meanwhile; returns `false` at shutdown.
async fn wait(
    pause: Option<Duration>,
    supervision: &mut Supervision,
    shutdown: &mut (impl Future<Output = ()> + Unpin),
) -> bool {
    let deadline = pause.and_then(|pause| Instant::now().checked_add(pause));
    loop {
        let timer = async {
            match deadline {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            () = &mut *shutdown => return false,
            () = timer => return true,
            () = supervision.outbox.room_for_reconciliation() => supervision.outbox.flush_overflow(),
            command = supervision.commands.recv() => match command {
                None => return false,
                Some(command) => {
                    let was_empty = supervision.subscriptions.is_empty();
                    supervision.obey(command);
                    if was_empty && !supervision.subscriptions.is_empty() {
                        return true;
                    }
                }
            },
        }
    }
}

#[cfg(test)]
#[path = "tests/control_outbox.rs"]
mod tests;
