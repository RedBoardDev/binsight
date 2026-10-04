//! The JSON-RPC frames of `logsSubscribe`: writing requests and reading what the server sends.
//!
//! The server sends three kinds of frames: answers to requests (a subscription id, or `true` for
//! an unsubscribe), errors (to a request, or to nothing in particular), and notifications. Only
//! a notification's signature, slot and failure flag are read: its logs are cut at 10 kB, and the
//! transaction itself is fetched separately. A frame binsight does not recognise is reported as
//! such, never silently taken for something else. This module is pure.

use binsight_solana::{Address, Signature};
use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;

/// The commitment notifications are sent at: confirmed is seconds earlier than finalized, and
/// the transaction is fetched at finalized anyway.
const NOTIFICATION_COMMITMENT: &str = "confirmed";

/// The longest server error message kept, in characters.
const MAX_ERROR_MESSAGE_CHARS: usize = 200;

/// What a frame from the server says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ServerFrame {
    /// The request `request_id` was answered with a subscription id.
    SubscriptionStarted {
        /// The request answered.
        request_id: u64,
        /// The subscription the server created.
        subscription: u64,
    },
    /// The request `request_id` was answered with anything else (an unsubscribe's `true`).
    Answered {
        /// The request answered.
        request_id: u64,
    },
    /// An error, answering `request_id` if it says so.
    Error {
        /// The request it answers, if any.
        request_id: Option<u64>,
        /// The JSON-RPC error code.
        code: i64,
        /// The message, shortened.
        message: String,
    },
    /// A transaction mentioned the subscription's wallet.
    Notification {
        /// The subscription notified.
        subscription: u64,
        /// The transaction's signature.
        signature: Signature,
        /// The slot it was confirmed in.
        slot: u64,
        /// Whether it failed.
        is_failed: bool,
    },
    /// A frame binsight does not recognise.
    Unrecognized,
}

#[derive(Deserialize)]
struct Frame {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<ErrorBody>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Option<NotificationParams>,
}

#[derive(Deserialize)]
struct ErrorBody {
    code: i64,
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct NotificationParams {
    subscription: u64,
    result: NotificationResult,
}

#[derive(Deserialize)]
struct NotificationResult {
    context: NotificationContext,
    value: NotificationValue,
}

#[derive(Deserialize)]
struct NotificationContext {
    slot: u64,
}

#[derive(Deserialize)]
struct NotificationValue {
    signature: String,
    #[serde(default)]
    err: Option<Box<RawValue>>,
}

/// The request that subscribes to the transactions mentioning `wallet`.
pub(crate) fn subscribe_request(request_id: u64, wallet: Address) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "logsSubscribe",
        "params": [
            { "mentions": [wallet.to_string()] },
            { "commitment": NOTIFICATION_COMMITMENT },
        ],
    })
    .to_string()
}

/// The request that ends `subscription`.
pub(crate) fn unsubscribe_request(request_id: u64, subscription: u64) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "logsUnsubscribe",
        "params": [subscription],
    })
    .to_string()
}

/// Reads a text frame from the server.
pub(crate) fn read_frame(text: &str) -> ServerFrame {
    let Ok(frame) = serde_json::from_str::<Frame>(text) else {
        return ServerFrame::Unrecognized;
    };
    if let Some(error) = frame.error {
        return ServerFrame::Error {
            request_id: frame.id,
            code: error.code,
            message: error
                .message
                .chars()
                .take(MAX_ERROR_MESSAGE_CHARS)
                .collect(),
        };
    }
    if let (Some(request_id), Some(result)) = (frame.id, frame.result) {
        return match result.as_u64() {
            Some(subscription) => ServerFrame::SubscriptionStarted {
                request_id,
                subscription,
            },
            None => ServerFrame::Answered { request_id },
        };
    }
    match (frame.method.as_deref(), frame.params) {
        (Some("logsNotification"), Some(params)) => read_notification(params),
        _ => ServerFrame::Unrecognized,
    }
}

fn read_notification(params: NotificationParams) -> ServerFrame {
    let value = params.result.value;
    let Ok(signature) = value.signature.parse::<Signature>() else {
        return ServerFrame::Unrecognized;
    };
    ServerFrame::Notification {
        subscription: params.subscription,
        signature,
        slot: params.result.context.slot,
        is_failed: value.err.is_some_and(|err| err.get() != "null"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_logs_subscription_mentioning_the_wallet_at_confirmed() {
        let wallet = Address::from_bytes([3; 32]);

        let request: Value = serde_json::from_str(&subscribe_request(7, wallet)).unwrap();

        assert_eq!(request["id"], 7);
        assert_eq!(request["method"], "logsSubscribe");
        assert_eq!(request["params"][0]["mentions"][0], wallet.to_string());
        assert_eq!(request["params"][1]["commitment"], "confirmed");
    }

    #[test]
    fn reads_a_subscription_answer_and_an_unsubscribe_answer() {
        assert_eq!(
            read_frame(r#"{"jsonrpc":"2.0","result":24040,"id":1}"#),
            ServerFrame::SubscriptionStarted {
                request_id: 1,
                subscription: 24_040
            }
        );
        assert_eq!(
            read_frame(r#"{"jsonrpc":"2.0","result":true,"id":2}"#),
            ServerFrame::Answered { request_id: 2 }
        );
    }

    #[test]
    fn reads_an_error_with_or_without_its_request() {
        let refused =
            r#"{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params"},"id":3}"#;
        let loose = r#"{"jsonrpc":"2.0","error":{"code":-32600,"message":"not available"}}"#;

        assert_eq!(
            read_frame(refused),
            ServerFrame::Error {
                request_id: Some(3),
                code: -32_602,
                message: "Invalid params".to_owned()
            }
        );
        assert!(matches!(
            read_frame(loose),
            ServerFrame::Error {
                request_id: None,
                ..
            }
        ));
    }

    #[test]
    fn reads_the_signature_slot_and_failure_of_a_notification() {
        let signature = Signature::from_bytes([9; 64]);
        let notification = |err: &str| {
            format!(
                r#"{{"jsonrpc":"2.0","method":"logsNotification","params":{{"result":
                {{"context":{{"slot":5208469}},"value":{{"signature":"{signature}","err":{err},
                "logs":["Program 11111111111111111111111111111111 invoke [1]"]}}}},
                "subscription":24040}}}}"#
            )
        };

        let succeeded = read_frame(&notification("null"));
        let failed = read_frame(&notification(r#"{"InstructionError":[0,"Custom"]}"#));

        assert_eq!(
            succeeded,
            ServerFrame::Notification {
                subscription: 24_040,
                signature,
                slot: 5_208_469,
                is_failed: false
            }
        );
        assert!(matches!(
            failed,
            ServerFrame::Notification {
                is_failed: true,
                ..
            }
        ));
    }

    #[test]
    fn reports_a_frame_it_does_not_recognise() {
        assert_eq!(read_frame("not json"), ServerFrame::Unrecognized);
        assert_eq!(
            read_frame(r#"{"jsonrpc":"2.0","method":"slotNotification","params":{}}"#),
            ServerFrame::Unrecognized
        );
    }
}
