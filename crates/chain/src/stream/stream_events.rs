//! What the live stream tells the engine, and what the engine tells it.
//!
//! The stream reports its own state (connected, disconnected and why), each wallet's
//! subscription (confirmed or refused), every server error it receives, and the activity it sees:
//! a signature that mentions a watched wallet. Nothing is ever swallowed: a refused subscription
//! or an error frame is an event, so the health can tell a silent stream from a broken one. This
//! module only names the messages.

use binsight_solana::{Address, Signature};
use std::collections::{BTreeMap, BTreeSet};

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
    /// A subscribe request was not acknowledged before its deadline.
    SubscriptionUnanswered {
        /// The wallet whose subscription could not be established.
        wallet: Address,
    },
    /// The credit budget refuses the stream until the limit resets.
    BudgetRefused,
    /// No wallet is watched any more: an open stream would cost credits for nothing.
    NothingToWatch,
}

/// The latest subscription fact, retained independently of the bounded activity channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubscriptionStatus {
    /// The server acknowledged the subscription.
    Subscribed,
    /// The server refused the wallet.
    Refused {
        /// JSON-RPC error code.
        code: i64,
        /// Short provider error message.
        message: String,
    },
}

/// A control snapshot that makes an overflow recoverable without stale health.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StreamSnapshot {
    /// Wallets for which a connection is needed.
    pub watched: BTreeSet<Address>,
    /// Whether the connection is open.
    pub is_connected: bool,
    /// Latest subscription facts for the open connection.
    pub subscriptions: BTreeMap<Address, SubscriptionStatus>,
    /// Last reason the connection ended, cleared when it reopens.
    pub disconnect_reason: Option<DisconnectReason>,
}

impl StreamSnapshot {
    pub(super) fn apply(&mut self, event: &StreamEvent) {
        match event {
            StreamEvent::Connected => {
                self.is_connected = true;
                self.disconnect_reason = None;
            }
            StreamEvent::Disconnected { reason } => {
                self.is_connected = false;
                self.subscriptions.clear();
                self.disconnect_reason = Some(reason.clone());
            }
            StreamEvent::Subscribed { wallet } => {
                self.subscriptions
                    .insert(*wallet, SubscriptionStatus::Subscribed);
            }
            StreamEvent::SubscriptionRefused {
                wallet,
                code,
                message,
            } => {
                self.subscriptions.insert(
                    *wallet,
                    SubscriptionStatus::Refused {
                        code: *code,
                        message: message.clone(),
                    },
                );
            }
            StreamEvent::Reconciled(snapshot) => *self = snapshot.clone(),
            StreamEvent::Activity(_)
            | StreamEvent::Overflowed
            | StreamEvent::ServerError { .. } => {}
        }
    }
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
    /// Latest control facts after activity or control events were lost.
    Reconciled(StreamSnapshot),
}

/// What the engine asks of the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StreamCommand {
    /// Start watching a wallet.
    Watch(Address),
    /// Stop watching a wallet.
    Unwatch(Address),
}
