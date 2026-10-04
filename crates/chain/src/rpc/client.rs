//! The JSON-RPC client: one call, with its deadline and its retries.
//!
//! [`RpcClient`] is a cheap handle (clones share everything). Each call gets a request id, then
//! loops: send through the transport under the method's deadline, read the exchange, and either
//! return or wait as the retry policy says. There is exactly one retry policy, here; the
//! transport never retries on its own. The typed methods live in their own modules and build on
//! [`RpcClient::call`].

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tracing::debug;

use crate::error::RpcError;
use crate::rpc::call::CallContext;
use crate::rpc::envelope::{RpcResult, request_body};
use crate::rpc::exchange::Exchange;
use crate::rpc::method::RpcMethod;
use crate::rpc::retry::{Retry, decide};
use crate::rpc::transport::RpcTransport;

/// A JSON-RPC client of the Solana API.
#[derive(Clone)]
pub struct RpcClient {
    inner: Arc<ClientInner>,
}

struct ClientInner {
    transport: Arc<dyn RpcTransport>,
    next_request_id: AtomicU64,
}

impl RpcClient {
    /// A client sending through `transport`. Nothing is sent until the first call.
    pub fn new(transport: Arc<dyn RpcTransport>) -> Self {
        Self {
            inner: Arc::new(ClientInner {
                transport,
                next_request_id: AtomicU64::new(1),
            }),
        }
    }

    /// Calls `method` with `params`, retrying transient failures as the policy allows.
    pub(crate) async fn call(
        &self,
        method: RpcMethod,
        params: &Value,
        context: &CallContext,
    ) -> Result<RpcResult, RpcError> {
        let request_id = self.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        let body = request_body(request_id, method.name(), params);
        let mut attempt: u32 = 0;
        loop {
            attempt = attempt.saturating_add(1);
            let error = match self
                .exchange(method, body.clone())
                .await
                .into_result(method)
            {
                Ok(result) => return Ok(result),
                Err(error) => error,
            };
            match decide(&error, attempt, context.priority, request_id) {
                Retry::Never => return Err(error),
                Retry::After(delay) => {
                    debug!(
                        method = method.name(),
                        attempt,
                        delay_ms = delay.as_millis(),
                        %error,
                        "rpc call failed; trying again"
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }

    /// Sends one attempt under the method's deadline.
    async fn exchange(&self, method: RpcMethod, body: Vec<u8>) -> Exchange {
        let sending = self.inner.transport.send(body);
        match tokio::time::timeout(method.timeout(), sending).await {
            Err(_elapsed) => Exchange::TimedOut,
            Ok(Err(error)) => Exchange::Failed(error),
            Ok(Ok(reply)) => Exchange::Replied(reply),
        }
    }
}

impl fmt::Debug for RpcClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RpcClient")
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use binsight_core::credits::{Priority, Purpose};
    use binsight_solana::transaction::TxVersion;
    use binsight_solana::{Address, Signature};
    use serde_json::json;
    use tokio::time::Instant;

    use super::*;
    use crate::rpc::{SignaturesRequest, TransactionLookup};
    use crate::test_support::{ScriptedReply, ScriptedTransport};

    fn context(priority: Priority) -> CallContext {
        CallContext {
            priority,
            purpose: Purpose::TransactionFetch,
            wallet: None,
        }
    }

    fn client(transport: &Arc<ScriptedTransport>) -> RpcClient {
        RpcClient::new(transport.clone())
    }

    #[tokio::test(start_paused = true)]
    async fn retries_a_silent_provider_with_backoff_then_gives_up() {
        let transport = ScriptedTransport::new();
        for _ in 0..3 {
            transport
                .expect("getTransaction")
                .respond(ScriptedReply::Hang);
        }
        let started = Instant::now();

        let outcome = client(&transport)
            .transaction(Signature::from_bytes([1; 64]), context(Priority::History))
            .await;

        assert_eq!(outcome, Err(RpcError::Timeout));
        assert_eq!(transport.calls().len(), 3);
        assert!(started.elapsed() >= Duration::from_secs(45));
        assert!(started.elapsed() < Duration::from_secs(47));
    }

    #[tokio::test(start_paused = true)]
    async fn never_retries_an_unauthorized_key() {
        let transport = ScriptedTransport::new();
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::Http {
                status: 401,
                retry_after: None,
                body: "Unauthorized".to_owned(),
            });

        let outcome = client(&transport)
            .transaction(Signature::from_bytes([1; 64]), context(Priority::Realtime))
            .await;

        assert_eq!(outcome, Err(RpcError::Unauthorized));
        assert_eq!(transport.calls().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn sends_an_unreadable_answer_back_without_paying_for_it_again() {
        let transport = ScriptedTransport::new();
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::Http {
                status: 200,
                retry_after: None,
                body: "<html>maintenance</html>".to_owned(),
            });

        let outcome = client(&transport)
            .transaction(Signature::from_bytes([1; 64]), context(Priority::CatchUp))
            .await;

        assert!(matches!(outcome, Err(RpcError::UnexpectedResponse { .. })));
        assert_eq!(transport.calls().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn waits_as_long_as_retry_after_asks_before_trying_again() {
        let transport = ScriptedTransport::new();
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::Http {
                status: 429,
                retry_after: Some(Duration::from_secs(3)),
                body: "Too many requests".to_owned(),
            });
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::Null);
        let started = Instant::now();

        let outcome = client(&transport)
            .transaction(Signature::from_bytes([1; 64]), context(Priority::CatchUp))
            .await;

        assert_eq!(outcome, Ok(TransactionLookup::NotFound));
        assert_eq!(started.elapsed(), Duration::from_secs(3));
    }

    #[tokio::test(start_paused = true)]
    async fn parks_a_transaction_too_new_to_read_without_retrying() {
        let transport = ScriptedTransport::new();
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::RpcError {
                code: -32015,
                message: "Transaction version (2) is not supported".to_owned(),
            });

        let outcome = client(&transport)
            .transaction(Signature::from_bytes([1; 64]), context(Priority::Realtime))
            .await;

        assert_eq!(outcome, Err(RpcError::UnsupportedTransactionVersion));
        assert_eq!(transport.calls().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn asks_for_a_finalized_base64_transaction_up_to_version_1() {
        let signature = Signature::from_bytes([2; 64]);
        let transport = ScriptedTransport::new();
        transport
            .expect("getTransaction")
            .with_params(json!([
                signature.to_string(),
                {"encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 1}
            ]))
            .respond(ScriptedReply::Result(json!({"slot": 9, "version": 1, "meta": {"err": null}})));

        let outcome = client(&transport)
            .transaction(signature, context(Priority::History))
            .await
            .unwrap();

        let TransactionLookup::Found(transaction) = outcome else {
            panic!("not found");
        };
        assert_eq!(transaction.version, TxVersion::V1);
        transport.assert_no_unexpected_calls();
    }

    #[tokio::test(start_paused = true)]
    async fn lists_the_page_older_than_the_given_signature() {
        let address = Address::from_bytes([4; 32]);
        let before = Signature::from_bytes([5; 64]);
        let transport = ScriptedTransport::new();
        transport
            .expect("getSignaturesForAddress")
            .with_params(json!([
                address.to_string(),
                {"limit": 1000, "commitment": "finalized", "before": before.to_string()}
            ]))
            .respond(ScriptedReply::Result(json!([])));
        let request = SignaturesRequest {
            address,
            before: Some(before),
        };

        let page = client(&transport)
            .signatures_for_address(request, context(Priority::CatchUp))
            .await;

        assert_eq!(page, Ok(Vec::new()));
        transport.assert_no_unexpected_calls();
    }
}
