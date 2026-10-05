//! A WebSocket connector that plays a scripted Helius stream, so tests never open a socket.
//!
//! By default every connection opens, every subscription is confirmed (its id is the request's)
//! and every ping is answered. A test can change that (refuse the next connection, refuse
//! subscriptions, stop answering pings), push a notification for a wallet, close the current
//! connection as a server would, and read every frame the client sent. Time-related behaviour
//! relies on the supervisor's timers, which tests run on tokio's paused clock.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use binsight_solana::{Address, Signature};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

use crate::error::StreamError;
use crate::stream::{
    ConnectFuture, WsConnection, WsConnector, WsMessage, WsReceiveFuture, WsSendFuture,
};

/// Which client write the scripted connection never completes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamWrite {
    /// A subscribe request.
    Subscribe,
    /// An unsubscribe request.
    Unsubscribe,
    /// A keep-alive ping.
    Ping,
}

/// A connector that plays a scripted stream.
#[derive(Debug, Default)]
pub struct ScriptedConnector {
    script: Arc<Mutex<StreamScript>>,
    connected: Arc<Notify>,
}

#[derive(Debug, Default)]
struct StreamScript {
    refused_connections: VecDeque<String>,
    subscription_refusal: Option<(i64, String)>,
    is_deaf_to_pings: bool,
    opened: u32,
    is_connect_blocked: bool,
    blocked_write: Option<StreamWrite>,
    delayed_write: Option<(StreamWrite, Duration)>,
    are_acks_withheld: bool,
    /// The server side of the open connection: what it sends to the client.
    to_client: Option<mpsc::UnboundedSender<WsMessage>>,
    /// The subscription id of each subscribed wallet on the open connection.
    subscriptions: HashMap<Address, u64>,
    sent: Vec<String>,
}

impl ScriptedConnector {
    /// A connector whose connections open, confirm every subscription and answer every ping.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Leaves connection opening pending until the client cancels it.
    pub fn block_connections(&self) {
        self.lock().is_connect_blocked = true;
    }

    /// Waits for the first open connection without advancing time or polling.
    pub async fn wait_until_connected(&self) {
        loop {
            let notified = self.connected.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.connections_opened() > 0 {
                return;
            }
            notified.await;
        }
    }

    /// Fails the next connection attempt with `detail`.
    pub fn refuse_next_connection(&self, detail: &str) {
        self.lock().refused_connections.push_back(detail.to_owned());
    }

    /// Answers every subscription from now on with this JSON-RPC error.
    pub fn refuse_subscriptions(&self, code: i64, message: &str) {
        self.lock().subscription_refusal = Some((code, message.to_owned()));
    }

    /// Confirms subscriptions again.
    pub fn accept_subscriptions(&self) {
        self.lock().subscription_refusal = None;
    }

    /// Stops answering pings, like a half-open connection.
    pub fn ignore_pings(&self) {
        self.lock().is_deaf_to_pings = true;
    }

    /// Leaves writes of this kind pending, like a saturated TCP socket.
    pub fn block_writes(&self, kind: StreamWrite) {
        self.lock().blocked_write = Some(kind);
    }

    /// Delays each matching write on the injected Tokio clock.
    pub fn delay_writes(&self, kind: StreamWrite, delay: Duration) {
        self.lock().delayed_write = Some((kind, delay));
    }

    /// Stops acknowledging subscriptions while still answering pings.
    pub fn withhold_subscription_acks(&self) {
        self.lock().are_acks_withheld = true;
    }

    /// How many connections were opened.
    pub fn connections_opened(&self) -> u32 {
        self.lock().opened
    }

    /// Every text frame the client sent, in order, across connections.
    pub fn sent_frames(&self) -> Vec<String> {
        self.lock().sent.clone()
    }

    /// Whether `wallet` is subscribed on the open connection.
    pub fn is_subscribed(&self, wallet: Address) -> bool {
        let script = self.lock();
        script.to_client.is_some() && script.subscriptions.contains_key(&wallet)
    }

    /// Sends a notification of `signature`, confirmed in `slot`, to `wallet`'s subscription.
    ///
    /// # Panics
    ///
    /// Panics if `wallet` is not subscribed on an open connection: the test is wrong.
    #[expect(
        clippy::panic,
        reason = "test support: a notification for a wallet nobody subscribed is a wrong test"
    )]
    pub fn notify(&self, wallet: Address, signature: Signature, slot: u64, is_failed: bool) {
        let mut script = self.lock();
        let subscription = *script
            .subscriptions
            .get(&wallet)
            .unwrap_or_else(|| panic!("{wallet} is not subscribed"));
        let err = if is_failed {
            json!({ "InstructionError": [0, "Custom"] })
        } else {
            Value::Null
        };
        let frame = json!({
            "jsonrpc": "2.0",
            "method": "logsNotification",
            "params": {
                "result": {
                    "context": { "slot": slot },
                    "value": { "signature": signature.to_string(), "err": err, "logs": [] },
                },
                "subscription": subscription,
            },
        });
        script.deliver(WsMessage::Text(frame.to_string()));
    }

    /// Sends a raw text frame on the open connection.
    pub fn push_text(&self, text: &str) {
        self.lock().deliver(WsMessage::Text(text.to_owned()));
    }

    /// Ends the open connection as a server dropping it would.
    pub fn drop_connection(&self) {
        let mut script = self.lock();
        script.to_client = None;
        script.subscriptions.clear();
    }

    fn lock(&self) -> MutexGuard<'_, StreamScript> {
        self.script.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl StreamScript {
    fn deliver(&mut self, message: WsMessage) {
        if let Some(to_client) = &self.to_client {
            // A connection the client already dropped simply loses the frame.
            let _ = to_client.send(message);
        }
    }

    /// The server's answer to a text frame the client sent.
    fn answer(&mut self, text: &str) {
        self.sent.push(text.to_owned());
        let Ok(request) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let answer = match request.get("method").and_then(Value::as_str) {
            Some("logsSubscribe") if self.are_acks_withheld => return,
            Some("logsSubscribe") => self.answer_subscription(&request, &id),
            Some("logsUnsubscribe") => json!({ "jsonrpc": "2.0", "id": id, "result": true }),
            _ => return,
        };
        self.deliver(WsMessage::Text(answer.to_string()));
    }

    /// Confirms a subscription (its id is the request's), or refuses it as scripted.
    fn answer_subscription(&mut self, request: &Value, id: &Value) -> Value {
        if let Some((code, message)) = self.subscription_refusal.clone() {
            return json!({
                "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message },
            });
        }
        let wallet = request
            .pointer("/params/0/mentions/0")
            .and_then(Value::as_str)
            .and_then(|wallet| wallet.parse::<Address>().ok());
        if let Some(wallet) = wallet {
            self.subscriptions.insert(wallet, id.as_u64().unwrap_or(0));
        }
        json!({ "jsonrpc": "2.0", "id": id, "result": id })
    }
}

impl WsConnector for ScriptedConnector {
    fn connect(&self) -> ConnectFuture<'_> {
        let script = self.script.clone();
        let connected = self.connected.clone();
        Box::pin(async move {
            let is_blocked = script
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_connect_blocked;
            if is_blocked {
                return std::future::pending().await;
            }
            let mut state = script.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(detail) = state.refused_connections.pop_front() {
                return Err(StreamError::Connect { detail });
            }
            let (to_client, from_server) = mpsc::unbounded_channel();
            state.opened = state.opened.saturating_add(1);
            state.to_client = Some(to_client);
            state.subscriptions.clear();
            drop(state);
            connected.notify_waiters();
            let connection: Box<dyn WsConnection> = Box::new(ScriptedConnection {
                script: script.clone(),
                from_server,
            });
            Ok(connection)
        })
    }
}

/// The client side of a scripted connection.
struct ScriptedConnection {
    script: Arc<Mutex<StreamScript>>,
    from_server: mpsc::UnboundedReceiver<WsMessage>,
}

impl WsConnection for ScriptedConnection {
    fn send(&mut self, message: WsMessage) -> WsSendFuture<'_> {
        let script = self.script.lock().unwrap_or_else(PoisonError::into_inner);
        let kind = match &message {
            WsMessage::Ping(_) => Some(StreamWrite::Ping),
            WsMessage::Text(text) => serde_json::from_str::<Value>(text)
                .ok()
                .and_then(
                    |request| match request.get("method").and_then(Value::as_str) {
                        Some("logsSubscribe") => Some(StreamWrite::Subscribe),
                        Some("logsUnsubscribe") => Some(StreamWrite::Unsubscribe),
                        _ => None,
                    },
                ),
            _ => None,
        };
        if kind.is_some() && kind == script.blocked_write {
            return Box::pin(std::future::pending());
        }
        let delay = script
            .delayed_write
            .filter(|(delayed, _)| Some(*delayed) == kind);
        drop(script);
        Box::pin(async move {
            if let Some((_, delay)) = delay {
                tokio::time::sleep(delay).await;
            }
            let mut script = self.script.lock().unwrap_or_else(PoisonError::into_inner);
            match message {
                WsMessage::Text(text) => script.answer(&text),
                WsMessage::Ping(payload) if !script.is_deaf_to_pings => {
                    script.deliver(WsMessage::Pong(payload));
                }
                WsMessage::Close => {
                    script.to_client = None;
                    script.subscriptions.clear();
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Binary(_) => {}
            }
            Ok(())
        })
    }

    fn receive(&mut self) -> WsReceiveFuture<'_> {
        Box::pin(async move { self.from_server.recv().await.map(Ok) })
    }
}
