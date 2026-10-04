//! The seam between the RPC client and the network.
//!
//! A transport sends one JSON-RPC body and returns the raw HTTP answer: no retry, no metering, no
//! deadline (the client applies those, the same way for every transport). There are two
//! implementations: [`crate::HttpTransport`] for the real provider and, for tests, the scripted
//! transport of the `test-support` feature.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use crate::error::TransportError;

/// The raw HTTP answer to one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    /// The HTTP status code.
    pub status: u16,
    /// The `Retry-After` delay, when the provider sent one in seconds.
    pub retry_after: Option<Duration>,
    /// The response body.
    pub body: Vec<u8>,
}

/// The future a transport returns: the HTTP answer, or why there is none.
pub type SendFuture<'transport> =
    Pin<Box<dyn Future<Output = Result<HttpReply, TransportError>> + Send + 'transport>>;

/// Sends JSON-RPC request bodies to the provider.
pub trait RpcTransport: Send + Sync {
    /// Sends one JSON-RPC request body and waits for the HTTP answer, however long it takes.
    fn send(&self, body: Vec<u8>) -> SendFuture<'_>;
}
