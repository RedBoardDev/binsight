//! What the live stream tells the engine, and what the engine tells it.
//!
//! The stream reports its own state (connected, disconnected and why), each wallet's
//! subscription (confirmed or refused), every server error it receives, and the activity it sees:
//! a signature that mentions a watched wallet. Nothing is ever swallowed: a refused subscription
//! or an error frame is an event, so the health can tell a silent stream from a broken one. This
//! module only names the messages.

use binsight_solana::{Address, Signature};

/// A transaction the stream saw mentioning a watched wallet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Activity {
    /// The watched wallet it mentions.
    pub wallet: Address,
    /// Its signature.
    pub signature: Signature,
    /// The slot it was confirmed in.
    pub slot: u64,
    /// Whether it failed (it still paid its fee).
    pub is_failed: bool,
}

/// Why the stream's connection ended or could not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DisconnectReason {
    /// The connection could not be opened.
    ConnectFailed {
        /// What failed, without the URL.
        detail: String,
    },
    /// The connection broke or the server closed it.
    ConnectionLost {
        /// What happened, without the URL.
        detail: String,
    },
    /// Nothing came back within the deadline after a ping: the connection was half open.
    Unanswered,
    /// The credit budget refuses the stream until the limit resets.
    BudgetRefused,
    /// No wallet is watched any more: an open stream would cost credits for nothing.
    NothingToWatch,
}

/// Something the stream wants the engine to know.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    /// A connection is open; subscriptions follow.
    Connected,
    /// The connection ended, or could not be opened; the stream tries again after a backoff.
    Disconnected {
        /// Why.
        reason: DisconnectReason,
    },
    /// The server confirmed `wallet`'s subscription: from now on its activity is seen.
    Subscribed {
        /// The wallet.
        wallet: Address,
    },
    /// The server refused `wallet`'s subscription; the stream asks again later.
    SubscriptionRefused {
        /// The wallet.
        wallet: Address,
        /// The JSON-RPC error code.
        code: i64,
        /// The server's message, shortened.
        message: String,
    },
    /// The server sent an error that answers no subscription.
    ServerError {
        /// The JSON-RPC error code.
        code: i64,
        /// The server's message, shortened.
        message: String,
    },
    /// A watched wallet was mentioned by a transaction.
    Activity(Activity),
    /// Events were lost because the engine fell behind: whatever happened meanwhile must be
    /// listed again.
    Overflowed,
}

/// What the engine asks of the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StreamCommand {
    /// Start watching a wallet.
    Watch(Address),
    /// Stop watching a wallet.
    Unwatch(Address),
}
