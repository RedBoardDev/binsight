//! The JSON-RPC 2.0 envelope: writing a request body and reading the answer's `result` or
//! `error`.
//!
//! The `result` is kept as raw JSON text ([`RawValue`]) so a transaction can be stored exactly as
//! the node wrote it; each method parses what it needs from it. A `null` result is a normal
//! answer ("not found"), distinct from an error, and distinct from an answer with no `result`
//! at all, which is unreadable. This module only handles the envelope; what the HTTP status
//! means is decided by the client.

use serde::{Deserialize, Deserializer};
use serde_json::Value;
use serde_json::value::RawValue;

/// The longest node error message kept, in characters; nodes sometimes echo whole payloads.
const MAX_ERROR_MESSAGE_CHARS: usize = 200;

/// A successful JSON-RPC answer.
#[derive(Debug)]
pub(crate) enum RpcResult {
    /// The node returned a value.
    Value(Box<RawValue>),
    /// The node returned `null`.
    Null,
}

/// What a JSON-RPC answer body holds.
#[derive(Debug)]
pub(crate) enum RpcAnswer {
    /// A result (possibly `null`).
    Result(RpcResult),
    /// A JSON-RPC error object.
    Error {
        /// The error code.
        code: i64,
        /// The message, shortened to [`MAX_ERROR_MESSAGE_CHARS`].
        message: String,
    },
}

/// Why an answer body could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum UnreadableAnswer {
    /// The body is not a JSON-RPC answer.
    #[error("the answer is not JSON-RPC: {0}")]
    NotJsonRpc(#[from] serde_json::Error),
    /// The body has neither a `result` nor an `error` member.
    #[error("the answer has neither a result nor an error")]
    NoResult,
}

#[derive(Deserialize)]
struct AnswerBody {
    /// `None` when the member is absent; a JSON `null` is kept as the raw text `null`.
    #[serde(default, deserialize_with = "present_member")]
    result: Option<Box<RawValue>>,
    #[serde(default)]
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
struct ErrorBody {
    code: i64,
    #[serde(default)]
    message: String,
}

/// The body of a JSON-RPC 2.0 request.
pub(crate) fn request_body(id: u64, method: &str, params: &Value) -> Vec<u8> {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    request.to_string().into_bytes()
}

/// Marks a member as present, whatever its value: `null` included.
fn present_member<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Box<RawValue>>, D::Error> {
    Box::<RawValue>::deserialize(deserializer).map(Some)
}

/// Reads an answer body.
pub(crate) fn parse_answer(body: &[u8]) -> Result<RpcAnswer, UnreadableAnswer> {
    let answer: AnswerBody = serde_json::from_slice(body)?;
    if let Some(error) = answer.error {
        return Ok(RpcAnswer::Error {
            code: error.code,
            message: error
                .message
                .chars()
                .take(MAX_ERROR_MESSAGE_CHARS)
                .collect(),
        });
    }
    match answer.result {
        None => Err(UnreadableAnswer::NoResult),
        Some(value) if value.get() == "null" => Ok(RpcAnswer::Result(RpcResult::Null)),
        Some(value) => Ok(RpcAnswer::Result(RpcResult::Value(value))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_json_rpc_2_request() {
        let body = request_body(7, "getBalance", &serde_json::json!(["abc"]));

        let written: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            written,
            serde_json::json!({"jsonrpc": "2.0", "id": 7, "method": "getBalance", "params": ["abc"]})
        );
    }

    #[test]
    fn keeps_the_result_as_the_node_wrote_it() {
        let body = br#"{"jsonrpc":"2.0","id":1,"result":{"b": 1.50, "a":[ 2 ]}}"#;

        let Ok(RpcAnswer::Result(RpcResult::Value(raw))) = parse_answer(body) else {
            panic!("not a value");
        };
        assert_eq!(raw.get(), r#"{"b": 1.50, "a":[ 2 ]}"#);
    }

    #[test]
    fn reads_a_null_result_as_null_and_not_as_an_error() {
        let body = br#"{"jsonrpc":"2.0","id":1,"result":null}"#;

        assert!(matches!(
            parse_answer(body),
            Ok(RpcAnswer::Result(RpcResult::Null))
        ));
    }

    #[test]
    fn reads_an_error_and_shortens_a_long_message() {
        let message = "x".repeat(1_000);
        let body = format!(
            r#"{{"jsonrpc":"2.0","id":1,"error":{{"code":-32015,"message":"{message}"}}}}"#
        );

        let Ok(RpcAnswer::Error { code, message }) = parse_answer(body.as_bytes()) else {
            panic!("not an error");
        };
        assert_eq!(code, -32015);
        assert_eq!(message.chars().count(), MAX_ERROR_MESSAGE_CHARS);
    }

    #[test]
    fn refuses_a_body_that_is_not_json() {
        assert!(matches!(
            parse_answer(b"<html>Bad gateway</html>"),
            Err(UnreadableAnswer::NotJsonRpc(_))
        ));
    }

    #[test]
    fn refuses_an_answer_without_a_result_instead_of_reading_it_as_null() {
        for body in [&br#"{"jsonrpc":"2.0","id":1}"#[..], b"{}"] {
            assert!(matches!(
                parse_answer(body),
                Err(UnreadableAnswer::NoResult)
            ));
        }
    }
}
