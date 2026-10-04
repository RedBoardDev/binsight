//! One open connection of the stream, from its subscriptions to its end.
//!
//! The session subscribes every watched wallet, then waits for whichever comes first: a frame
//! from the server, a command from the engine, the next ping or retry, or shutdown. Each frame is
//! billed by its size and then read (`server_frames`). The session ends when
//! the connection breaks, a ping goes unanswered, the budget stops the stream, no wallet is
//! watched any more, or shutdown is asked; every end but shutdown is a disconnection the
//! supervisor recovers from.

use std::time::Duration;

use tokio::time::{Instant, sleep_until, timeout};
use tracing::{debug, warn};

use super::data_billing::DataBilling;
use super::frames::{subscribe_request, unsubscribe_request};
use super::liveness::{Liveness, LivenessCheck};
use super::server_frames::read_frame_from_server;
use super::stream_events::{DisconnectReason, StreamCommand};
use super::supervisor::Supervision;
use super::ws_connection::{WsConnection, WsMessage};
use crate::error::StreamError;

/// How long a closing handshake may take at shutdown.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

/// How a session ended.
#[derive(Debug)]
pub(super) enum SessionEnd {
    /// Shutdown was asked; the connection was closed.
    Shutdown,
    /// The connection is gone; the supervisor opens another one.
    Lost(DisconnectReason),
}

/// What woke the session up.
enum Wake {
    Shutdown,
    Command(Option<StreamCommand>),
    Received(Option<Result<WsMessage, StreamError>>),
    Timer,
}

/// Runs one connection until it ends.
pub(super) async fn run_session(
    connection: &mut dyn WsConnection,
    supervision: &mut Supervision,
    shutdown: &mut (impl Future<Output = ()> + Unpin),
) -> SessionEnd {
    let mut liveness = Liveness::new(Instant::now());
    let mut billing = DataBilling::default();
    loop {
        if supervision.subscriptions.is_empty() {
            close(connection).await;
            return SessionEnd::Lost(DisconnectReason::NothingToWatch);
        }
        if let Err(reason) = send_due_subscriptions(connection, supervision).await {
            return SessionEnd::Lost(reason);
        }
        supervision.outbox.flush_overflow();
        let wake_at = next_wake(&liveness, supervision);
        let wake = tokio::select! {
            () = &mut *shutdown => Wake::Shutdown,
            command = supervision.commands.recv() => Wake::Command(command),
            received = connection.receive() => Wake::Received(received),
            () = sleep_until(wake_at) => Wake::Timer,
        };
        let step = match wake {
            Wake::Shutdown | Wake::Command(None) => {
                close(connection).await;
                return SessionEnd::Shutdown;
            }
            Wake::Command(Some(command)) => obey(command, connection, supervision).await,
            Wake::Received(received) => {
                receive(
                    received,
                    &mut liveness,
                    &mut billing,
                    connection,
                    supervision,
                )
                .await
            }
            Wake::Timer => keep_alive(&mut liveness, connection, supervision).await,
        };
        if let Err(reason) = step {
            return SessionEnd::Lost(reason);
        }
    }
}

/// When the session must wake up without a frame: the next liveness deadline or subscription
/// retry.
fn next_wake(liveness: &Liveness, supervision: &Supervision) -> Instant {
    let liveness_at = match liveness.check(Instant::now()) {
        LivenessCheck::WaitUntil(at) => at,
        LivenessCheck::Ping | LivenessCheck::Dead => Instant::now(),
    };
    supervision
        .subscriptions
        .next_retry_at()
        .map_or(liveness_at, |retry_at| retry_at.min(liveness_at))
}

/// Sends a ping when one is due; a connection whose last ping went unanswered is dead, and one
/// the credit budget no longer allows is closed.
async fn keep_alive(
    liveness: &mut Liveness,
    connection: &mut dyn WsConnection,
    supervision: &Supervision,
) -> Result<(), DisconnectReason> {
    if let Some(refusal) = supervision.rpc.governor().hard_refusal() {
        warn!(%refusal, "the stream is closed until the credit limit resets");
        close(connection).await;
        return Err(DisconnectReason::BudgetRefused);
    }
    let now = Instant::now();
    match liveness.check(now) {
        LivenessCheck::Dead => {
            warn!("the stream did not answer a ping; reconnecting");
            Err(DisconnectReason::Unanswered)
        }
        LivenessCheck::Ping => {
            liveness.pinged(now);
            send(connection, WsMessage::Ping(Vec::new())).await
        }
        LivenessCheck::WaitUntil(_) => Ok(()),
    }
}

/// Applies a command of the engine on this connection.
async fn obey(
    command: StreamCommand,
    connection: &mut dyn WsConnection,
    supervision: &mut Supervision,
) -> Result<(), DisconnectReason> {
    match command {
        StreamCommand::Watch(wallet) => {
            supervision.subscriptions.watch(wallet);
            Ok(())
        }
        StreamCommand::Unwatch(wallet) => match supervision.subscriptions.unwatch(wallet) {
            Some(subscription) => release(subscription, connection, supervision).await,
            None => Ok(()),
        },
    }
}

/// Handles what the connection delivered.
async fn receive(
    received: Option<Result<WsMessage, StreamError>>,
    liveness: &mut Liveness,
    billing: &mut DataBilling,
    connection: &mut dyn WsConnection,
    supervision: &mut Supervision,
) -> Result<(), DisconnectReason> {
    let message = match received {
        None | Some(Ok(WsMessage::Close)) => {
            return Err(DisconnectReason::ConnectionLost {
                detail: "the server closed the connection".to_owned(),
            });
        }
        Some(Err(error)) => {
            return Err(DisconnectReason::ConnectionLost {
                detail: error.to_string(),
            });
        }
        Some(Ok(message)) => message,
    };
    liveness.heard();
    let started_units = billing.delivered(message.billed_bytes());
    if started_units > 0 {
        let governor = supervision.rpc.governor();
        governor.charge_stream_data(started_units);
        if let Some(refusal) = governor.hard_refusal() {
            warn!(%refusal, "the stream is closed until the credit limit resets");
            close(connection).await;
            return Err(DisconnectReason::BudgetRefused);
        }
    }
    match message {
        WsMessage::Text(text) => read_frame_from_server(&text, connection, supervision).await,
        WsMessage::Binary(_) | WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Close => Ok(()),
    }
}

/// Sends the subscribe requests that are due.
async fn send_due_subscriptions(
    connection: &mut dyn WsConnection,
    supervision: &mut Supervision,
) -> Result<(), DisconnectReason> {
    for (request_id, wallet) in supervision.subscriptions.requests_due(Instant::now()) {
        send(
            connection,
            WsMessage::Text(subscribe_request(request_id, wallet)),
        )
        .await?;
    }
    Ok(())
}

/// Ends `subscription` on the server.
pub(super) async fn release(
    subscription: u64,
    connection: &mut dyn WsConnection,
    supervision: &mut Supervision,
) -> Result<(), DisconnectReason> {
    let request_id = supervision.subscriptions.new_request_id();
    let request = unsubscribe_request(request_id, subscription);
    send(connection, WsMessage::Text(request)).await
}

async fn send(
    connection: &mut dyn WsConnection,
    message: WsMessage,
) -> Result<(), DisconnectReason> {
    connection
        .send(message)
        .await
        .map_err(|error| DisconnectReason::ConnectionLost {
            detail: error.to_string(),
        })
}

/// Closes the connection politely, without waiting long for the server.
async fn close(connection: &mut dyn WsConnection) {
    if let Ok(Err(error)) = timeout(CLOSE_TIMEOUT, connection.send(WsMessage::Close)).await {
        debug!(%error, "the stream did not close cleanly");
    }
}
