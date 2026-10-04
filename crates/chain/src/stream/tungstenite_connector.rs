//! The real WebSocket: `tokio-tungstenite` over TCP and `rustls`.
//!
//! The connector opens the TCP connection, wraps it in TLS with the configuration the HTTP
//! transport uses, then runs the WebSocket handshake on it. The library answers the server's
//! pings by itself. Its errors may quote the request URL, and so the key: every message is
//! redacted before it leaves this module. Deadlines, pings and reconnection belong to the
//! supervisor.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use super::ws_connection::{
    ConnectFuture, WsConnection, WsConnector, WsMessage, WsReceiveFuture, WsSendFuture,
};
use crate::endpoint::StreamEndpoint;
use crate::error::StreamError;
use crate::tls;

/// The largest message accepted; a notification is a few kilobytes.
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

/// Opens WebSocket connections to one endpoint.
#[derive(Clone)]
pub struct TungsteniteConnector {
    endpoint: StreamEndpoint,
    tls: TlsConnector,
}

impl TungsteniteConnector {
    /// A connector to `endpoint`. Nothing is opened until the first connection.
    ///
    /// # Errors
    ///
    /// Returns [`StreamError::Connect`] if the TLS configuration cannot be built.
    pub fn new(endpoint: StreamEndpoint) -> Result<Self, StreamError> {
        let config = tls::client_config().map_err(|error| StreamError::Connect {
            detail: error.to_string(),
        })?;
        Ok(Self {
            endpoint,
            tls: TlsConnector::from(Arc::new(config)),
        })
    }

    async fn open(&self) -> Result<Box<dyn WsConnection>, StreamError> {
        let endpoint = &self.endpoint;
        let tcp = TcpStream::connect((endpoint.host(), endpoint.port()))
            .await
            .map_err(|error| self.connect_error(&error))?;
        // Notifications are small and latency matters more than packing them.
        tcp.set_nodelay(true)
            .map_err(|error| self.connect_error(&error))?;
        if !endpoint.is_secure() {
            return self.handshake(tcp).await;
        }
        let name = ServerName::try_from(endpoint.host().to_owned())
            .map_err(|error| self.connect_error(&error))?;
        let tls = self
            .tls
            .connect(name, tcp)
            .await
            .map_err(|error| self.connect_error(&error))?;
        self.handshake(tls).await
    }

    async fn handshake<S>(&self, stream: S) -> Result<Box<dyn WsConnection>, StreamError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE_BYTES));
        let (socket, _response) = tokio_tungstenite::client_async_with_config(
            self.endpoint.expose_url(),
            stream,
            Some(config),
        )
        .await
        .map_err(|error| self.connect_error(&error))?;
        Ok(Box::new(TungsteniteConnection {
            socket,
            endpoint: self.endpoint.clone(),
        }))
    }

    fn connect_error(&self, error: &dyn std::fmt::Display) -> StreamError {
        StreamError::Connect {
            detail: self.endpoint.redact(&error.to_string()),
        }
    }
}

impl std::fmt::Debug for TungsteniteConnector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TungsteniteConnector")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl WsConnector for TungsteniteConnector {
    fn connect(&self) -> ConnectFuture<'_> {
        Box::pin(self.open())
    }
}

/// One open connection.
struct TungsteniteConnection<S> {
    socket: WebSocketStream<S>,
    endpoint: StreamEndpoint,
}

impl<S> TungsteniteConnection<S> {
    fn connection_error(&self, error: &dyn std::fmt::Display) -> StreamError {
        StreamError::Connection {
            detail: self.endpoint.redact(&error.to_string()),
        }
    }
}

impl<S> WsConnection for TungsteniteConnection<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    fn send(&mut self, message: WsMessage) -> WsSendFuture<'_> {
        Box::pin(async move {
            let message = match message {
                WsMessage::Text(text) => Message::text(text),
                WsMessage::Binary(bytes) => Message::binary(bytes),
                WsMessage::Ping(bytes) => Message::Ping(bytes.into()),
                WsMessage::Pong(bytes) => Message::Pong(bytes.into()),
                WsMessage::Close => Message::Close(None),
            };
            let sent = self.socket.send(message).await;
            sent.map_err(|error| self.connection_error(&error))
        })
    }

    fn receive(&mut self) -> WsReceiveFuture<'_> {
        Box::pin(async move {
            loop {
                let received = match self.socket.next().await? {
                    Ok(received) => received,
                    Err(error) => return Some(Err(self.connection_error(&error))),
                };
                let message = match received {
                    Message::Text(text) => WsMessage::Text(text.as_str().to_owned()),
                    Message::Binary(bytes) => WsMessage::Binary(bytes.to_vec()),
                    Message::Ping(bytes) => WsMessage::Ping(bytes.to_vec()),
                    Message::Pong(bytes) => WsMessage::Pong(bytes.to_vec()),
                    Message::Close(_) => WsMessage::Close,
                    Message::Frame(_) => continue,
                };
                return Some(Ok(message));
            }
        })
    }
}
