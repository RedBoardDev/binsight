//! The errors of the chain client.
//!
//! [`RpcError`] says why a call failed in terms the caller can act on (try later, fix the key,
//! park the transaction); the retry policy reads it too. No error ever holds the API key or a URL
//! that contains it. This module only describes failures; it does not log or retry.

use std::time::Duration;

/// The transport could not exchange a request with the provider.
///
/// The detail comes from the HTTP library with the URL removed, so it never contains the key.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransportError {
    /// The connection to the provider could not be opened.
    #[error("could not connect to the RPC provider: {detail}")]
    Connect {
        /// What failed, without the URL.
        detail: String,
    },
    /// The request was sent but no complete answer could be read.
    #[error("the request to the RPC provider failed: {detail}")]
    Request {
        /// What failed, without the URL.
        detail: String,
    },
}

/// An RPC call failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RpcError {
    /// No answer arrived before the deadline.
    #[error("the RPC provider did not answer in time")]
    Timeout,
    /// The request could not be exchanged with the provider.
    #[error(transparent)]
    Transport(#[from] TransportError),
    /// The provider refused the request because too many were sent (HTTP 429).
    #[error("the RPC provider asked to slow down")]
    RateLimited {
        /// How long the provider asked to wait, if it said.
        retry_after: Option<Duration>,
    },
    /// The provider refused the request because the plan's credits are used up.
    #[error("the RPC provider's credits are used up for this billing cycle")]
    CreditsExhausted,
    /// The provider refused the API key.
    #[error("the RPC provider refused the API key")]
    Unauthorized,
    /// The provider does not offer this request on the current plan.
    #[error("the RPC provider does not offer {method} on this plan")]
    NotAvailableOnPlan {
        /// The refused method.
        method: &'static str,
    },
    /// The provider failed with a server error status (5xx).
    #[error("the RPC provider failed with HTTP status {status}")]
    ServerError {
        /// The HTTP status.
        status: u16,
    },
    /// The provider answered with an HTTP status binsight does not expect.
    #[error("the RPC provider answered with HTTP status {status}")]
    UnexpectedStatus {
        /// The HTTP status.
        status: u16,
    },
    /// The node is behind the cluster and cannot answer yet.
    #[error("the RPC node is behind the cluster (JSON-RPC error {code})")]
    NodeBehind {
        /// The JSON-RPC error code.
        code: i64,
    },
    /// The node cannot return a transaction of this version.
    #[error("the RPC node cannot return this transaction version")]
    UnsupportedTransactionVersion,
    /// The node refused the request as malformed; sending it again cannot help.
    #[error("the RPC node refused the request (JSON-RPC error {code}: {message})")]
    InvalidRequest {
        /// The JSON-RPC error code.
        code: i64,
        /// The node's message, shortened.
        message: String,
    },
    /// The node failed with another JSON-RPC error.
    #[error("the RPC node failed (JSON-RPC error {code}: {message})")]
    NodeError {
        /// The JSON-RPC error code.
        code: i64,
        /// The node's message, shortened.
        message: String,
    },
    /// The answer could not be read as the expected result.
    #[error("the answer to {method} could not be read: {detail}")]
    UnexpectedResponse {
        /// The method whose answer was unreadable.
        method: &'static str,
        /// What was wrong with it.
        detail: String,
    },
}
