//! A transport that answers from a script, so tests never touch the network.
//!
//! A test declares what it expects (`expect("getTransaction").with_params(…).respond(…)`); each
//! expectation answers one matching call, in the order they were declared. A call nobody expected
//! fails the test: it gets an HTTP 400 that is never retried, so the code under test returns
//! quickly, and it is kept aside, so [`ScriptedTransport::assert_no_unexpected_calls`] fails the
//! test, and dropping the transport fails it too if no one asserted. Every call is recorded for
//! inspection. Time-related answers (a hang) rely on the
//! client's deadline, which tests run on tokio's paused clock.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde_json::Value;

use crate::error::TransportError;
use crate::rpc::{HttpReply, RpcTransport, SendFuture};

/// The status a call nobody expected gets.
const UNEXPECTED_CALL_STATUS: u16 = 400;

/// What the scripted provider answers to one call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScriptedReply {
    /// A JSON-RPC result.
    Result(Value),
    /// A `null` JSON-RPC result.
    Null,
    /// A JSON-RPC error.
    RpcError {
        /// The error code.
        code: i64,
        /// The error message.
        message: String,
    },
    /// An HTTP answer with this status and body, such as a 429.
    Http {
        /// The HTTP status.
        status: u16,
        /// The `Retry-After` delay.
        retry_after: Option<Duration>,
        /// The body.
        body: String,
    },
    /// No answer, ever: the client's deadline must end the attempt.
    Hang,
}

/// A call the scripted provider received.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedCall {
    /// The JSON-RPC method.
    pub method: String,
    /// The JSON-RPC parameters.
    pub params: Value,
}

/// A transport that answers from a script.
#[derive(Debug, Default)]
pub struct ScriptedTransport {
    script: Mutex<Script>,
}

#[derive(Debug, Default)]
struct Script {
    expectations: Vec<Expectation>,
    calls: Vec<RecordedCall>,
    unexpected: Vec<RecordedCall>,
}

#[derive(Debug)]
struct Expectation {
    method: String,
    params: Option<Value>,
    reply: ScriptedReply,
}

/// An expectation being declared; it is added by [`ExpectationBuilder::respond`].
#[derive(Debug)]
#[must_use = "an expectation is only added by `respond`"]
pub struct ExpectationBuilder<'transport> {
    transport: &'transport ScriptedTransport,
    method: String,
    params: Option<Value>,
}

impl ExpectationBuilder<'_> {
    /// Only match a call with exactly these parameters.
    pub fn with_params(mut self, params: Value) -> Self {
        self.params = Some(params);
        self
    }

    /// Answers the matching call with `reply`.
    pub fn respond(self, reply: ScriptedReply) {
        self.transport.lock().expectations.push(Expectation {
            method: self.method,
            params: self.params,
            reply,
        });
    }
}

impl ScriptedTransport {
    /// A transport with an empty script: every call is unexpected.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Starts declaring an expected call of `method`.
    pub fn expect(&self, method: &str) -> ExpectationBuilder<'_> {
        ExpectationBuilder {
            transport: self,
            method: method.to_owned(),
            params: None,
        }
    }

    /// Every call received, in order.
    pub fn calls(&self) -> Vec<RecordedCall> {
        self.lock().calls.clone()
    }

    /// Fails the test if any call matched no expectation.
    ///
    /// # Panics
    ///
    /// Panics, listing them, if there were such calls.
    pub fn assert_no_unexpected_calls(&self) {
        let script = self.lock();
        assert!(
            script.unexpected.is_empty(),
            "the scripted provider received calls nobody expected: {:?}",
            script.unexpected
        );
    }

    /// Records the call and takes the first expectation it matches.
    fn answer(&self, call: RecordedCall) -> Option<ScriptedReply> {
        let mut script = self.lock();
        script.calls.push(call.clone());
        let position = script.expectations.iter().position(|expectation| {
            expectation.method == call.method
                && expectation
                    .params
                    .as_ref()
                    .is_none_or(|params| *params == call.params)
        });
        if let Some(index) = position {
            return Some(script.expectations.remove(index).reply);
        }
        script.unexpected.push(call);
        None
    }

    fn lock(&self) -> MutexGuard<'_, Script> {
        self.script.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Drop for ScriptedTransport {
    /// Fails a test that let an unexpected call through without asserting, unless it is already
    /// failing.
    fn drop(&mut self) {
        if !std::thread::panicking() {
            self.assert_no_unexpected_calls();
        }
    }
}

impl RpcTransport for ScriptedTransport {
    fn send(&self, body: Vec<u8>) -> SendFuture<'_> {
        let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let call = RecordedCall {
            method: request
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            params: request.get("params").cloned().unwrap_or(Value::Null),
        };
        let reply = self.answer(call);
        Box::pin(async move {
            match reply {
                None => Ok(http(UNEXPECTED_CALL_STATUS, None, "unexpected call")),
                Some(reply) => render(reply, id).await,
            }
        })
    }
}

/// Turns a scripted reply into what a real transport would return.
async fn render(reply: ScriptedReply, id: Value) -> Result<HttpReply, TransportError> {
    let envelope = |member: &str, value: Value| {
        serde_json::json!({ "jsonrpc": "2.0", "id": id, member: value }).to_string()
    };
    match reply {
        ScriptedReply::Result(value) => Ok(http(200, None, &envelope("result", value))),
        ScriptedReply::Null => Ok(http(200, None, &envelope("result", Value::Null))),
        ScriptedReply::RpcError { code, message } => {
            let error = serde_json::json!({ "code": code, "message": message });
            Ok(http(200, None, &envelope("error", error)))
        }
        ScriptedReply::Http {
            status,
            retry_after,
            body,
        } => Ok(http(status, retry_after, &body)),
        ScriptedReply::Hang => std::future::pending().await,
    }
}

fn http(status: u16, retry_after: Option<Duration>, body: &str) -> HttpReply {
    HttpReply {
        status,
        retry_after,
        body: body.as_bytes().to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call<'transport>(
        transport: &'transport ScriptedTransport,
        method: &str,
    ) -> SendFuture<'transport> {
        let body = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": []});
        transport.send(body.to_string().into_bytes())
    }

    #[tokio::test]
    async fn answers_the_expected_calls_in_order() {
        let transport = ScriptedTransport::new();
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::Null);

        let reply = call(&transport, "getTransaction").await.unwrap();

        assert_eq!(reply.status, 200);
        transport.assert_no_unexpected_calls();
    }

    #[tokio::test]
    #[should_panic(expected = "calls nobody expected")]
    async fn fails_the_test_on_a_call_nobody_expected() {
        let transport = ScriptedTransport::new();

        let reply = call(&transport, "getBalance").await.unwrap();

        assert_eq!(reply.status, UNEXPECTED_CALL_STATUS);
        transport.assert_no_unexpected_calls();
    }

    #[tokio::test]
    #[should_panic(expected = "calls nobody expected")]
    async fn fails_the_test_when_dropped_after_an_unchecked_unexpected_call() {
        let transport = ScriptedTransport::new();

        call(&transport, "getBalance").await.unwrap();

        drop(transport);
    }
}
