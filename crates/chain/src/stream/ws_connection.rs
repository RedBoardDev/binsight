//! The seam between the stream supervisor and the WebSocket.
//!
//! A connector opens connections; a connection sends and receives messages. There are two
//! implementations: [`crate::TungsteniteConnector`] for the real provider and, for tests, the
//! scripted connector of the `test-support` feature. Neither retries, meters or decides anything:
//! the supervisor does, the same way for both.

use std::future::Future;
use std::pin::Pin;

use crate::error::StreamError;

/// A WebSocket message, as the supervisor sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsMessage {
    /// A text frame (JSON-RPC).
    Text(String),
    /// A binary frame.
    Binary(Vec<u8>),
    /// A protocol ping.
    Ping(Vec<u8>),
    /// A protocol pong.
    Pong(Vec<u8>),
    /// The peer closes the connection.
    Close,
}

impl WsMessage {
    /// The bytes of data the provider bills for this message: the payload of data frames only.
    pub(crate) fn billed_bytes(&self) -> usize {
        match self {
            Self::Text(text) => text.len(),
            Self::Binary(bytes) => bytes.len(),
            Self::Ping(_) | Self::Pong(_) | Self::Close => 0,
        }
    }
}

/// The future of a connection being opened.
pub type ConnectFuture<'connector> =
    Pin<Box<dyn Future<Output = Result<Box<dyn WsConnection>, StreamError>> + Send + 'connector>>;

/// The future of a message being sent.
pub type WsSendFuture<'connection> =
    Pin<Box<dyn Future<Output = Result<(), StreamError>> + Send + 'connection>>;

/// The future of the next message received: `None` once the connection is closed.
pub type WsReceiveFuture<'connection> =
    Pin<Box<dyn Future<Output = Option<Result<WsMessage, StreamError>>> + Send + 'connection>>;

/// Opens WebSocket connections to the provider's stream.
pub trait WsConnector: Send + Sync {
    /// Opens one connection, however long it takes (the supervisor applies a deadline).
    fn connect(&self) -> ConnectFuture<'_>;
}

/// One open WebSocket connection.
pub trait WsConnection: Send {
    /// Sends one message.
    fn send(&mut self, message: WsMessage) -> WsSendFuture<'_>;

    /// Waits for the next message. Dropping the future before it completes loses nothing, so it
    /// can wait side by side with timers.
    fn receive(&mut self) -> WsReceiveFuture<'_>;
}
