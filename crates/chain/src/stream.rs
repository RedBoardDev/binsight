//! The live stream: one WebSocket connection to Helius with a `logsSubscribe` per watched wallet,
//! which tells the engine within a second or two that a wallet did something.
//!
//! The stream gives latency, not truth: it replays nothing, so whatever happens while it is down
//! is lost, and the engine lists every wallet again after each reconnection. It only reports a
//! notification's signature; the transaction itself is fetched like any other. The connection
//! is kept alive by protocol pings, reopened with a backoff when it breaks, opened only while a
//! wallet is watched, and billed through the same governor as the JSON-RPC calls: one credit per
//! opening, two per started tenth of a megabyte delivered. Refused subscriptions and server
//! errors are events, never swallowed.
//!
//! [`WalletStream::new`] builds the stream, the [`WalletWatch`] handle the engine uses to watch
//! and unwatch wallets, and the receiver of its [`StreamEvent`]s; [`WalletStream::run`] runs it
//! until shutdown.

mod data_billing;
mod frames;
mod liveness;
mod recent_signatures;
mod reconnect_backoff;
mod server_frames;
mod session;
mod stream_events;
mod subscriptions;
mod supervisor;
mod tungstenite_connector;
mod ws_connection;

pub use stream_events::{
    Activity, DisconnectReason, StreamEvent, StreamSnapshot, SubscriptionStatus,
};
pub use tungstenite_connector::TungsteniteConnector;
pub use ws_connection::{
    ConnectFuture, WsConnection, WsConnector, WsMessage, WsReceiveFuture, WsSendFuture,
};

use std::sync::Arc;

use binsight_solana::Address;
use tokio::sync::mpsc;
use tracing::debug;

use crate::rpc::RpcClient;
use stream_events::StreamCommand;
use supervisor::{EventOutbox, Supervision, supervise};

/// How many events may wait for the engine before the stream drops them and owes an
/// `Overflowed` marker.
const EVENT_CAPACITY: usize = 1_024;

/// Tells the stream which wallets to watch. Cheap to clone.
#[derive(Debug, Clone)]
pub struct WalletWatch {
    commands: mpsc::UnboundedSender<StreamCommand>,
}

impl WalletWatch {
    /// Starts watching `wallet` (again, if it was): its subscription is sent at once if the
    /// stream is connected, and on every connection after that.
    pub fn watch(&self, wallet: Address) {
        self.command(StreamCommand::Watch(wallet));
    }

    /// Stops watching `wallet` and releases its subscription.
    pub fn unwatch(&self, wallet: Address) {
        self.command(StreamCommand::Unwatch(wallet));
    }

    fn command(&self, command: StreamCommand) {
        if self.commands.send(command).is_err() {
            debug!(?command, "the stream has stopped; the command is moot");
        }
    }
}

/// The stream, ready to run.
pub struct WalletStream {
    connector: Arc<dyn WsConnector>,
    supervision: Supervision,
}

impl WalletStream {
    /// A stream opened through `connector` and billed through `rpc`'s governor, with the handle
    /// that watches wallets and the receiver of its events. Nothing is opened until a wallet is
    /// watched and [`WalletStream::run`] runs.
    pub fn new(
        connector: Arc<dyn WsConnector>,
        rpc: RpcClient,
    ) -> (Self, WalletWatch, mpsc::Receiver<StreamEvent>) {
        let (commands, command_receiver) = mpsc::unbounded_channel();
        let (events, event_receiver) = mpsc::channel(EVENT_CAPACITY);
        let supervision = Supervision {
            rpc: rpc.clone(),
            subscriptions: subscriptions::Subscriptions::default(),
            recent: recent_signatures::RecentSignatures::default(),
            outbox: EventOutbox::new(events, rpc),
            commands: command_receiver,
        };
        let stream = Self {
            connector,
            supervision,
        };
        (stream, WalletWatch { commands }, event_receiver)
    }

    /// Runs the stream until `shutdown` completes; the connection is then closed.
    pub async fn run(self, shutdown: impl Future<Output = ()>) {
        supervise(self.connector, self.supervision, shutdown).await;
    }
}

impl std::fmt::Debug for WalletStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WalletStream")
    }
}

#[cfg(test)]
mod tests;
