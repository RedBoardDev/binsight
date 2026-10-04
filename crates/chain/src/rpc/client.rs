//! The JSON-RPC client: one call, with its budget, pacing, deadline and retries.
//!
//! [`RpcClient`] is a cheap handle (clones share everything). Each call gets a request id, then
//! loops: the governor admits the attempt (the budget, then a rate slot in its priority's lane), the transport sends it
//! under the method's deadline, the meter counts it with its outcome, and the call either returns
//! or waits as the retry policy says. Every attempt is admitted and counted, so retries are never
//! invisible. There is exactly one retry policy, here; the transport never retries on its own.
//! The typed methods live in their own modules and build on [`RpcClient::call`].

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use binsight_core::clock::Clock;
use serde_json::Value;
use tracing::debug;

use crate::error::RpcError;
use crate::governor::{CreditMeter, Governor, GovernorSettings};
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
    governor: Governor,
    next_request_id: AtomicU64,
}

impl RpcClient {
    /// A client sending through `transport`, paced and capped by `governor`; `clock` dates the
    /// credit counts. Nothing is sent until the first call.
    pub fn new(
        transport: Arc<dyn RpcTransport>,
        governor: GovernorSettings,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            inner: Arc::new(ClientInner {
                transport,
                governor: Governor::new(governor, clock),
                next_request_id: AtomicU64::new(1),
            }),
        }
    }

    /// The credit meter, to restore today's spending at startup and to persist the counts.
    pub fn credit_meter(&self) -> &CreditMeter {
        self.inner.governor.meter()
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
            let governor = &self.inner.governor;
            governor.admit(method, context.priority).await?;
            let sent = governor.send(method, *context);
            let (outcome, result) = self.exchange(method, body.clone()).await.settle(method);
            sent.settle(outcome);
            let error = match result {
                Ok(result) => return Ok(result),
                Err(error) => error,
            };
            match error {
                RpcError::RateLimited { retry_after } => governor.cool_down(retry_after),
                RpcError::CreditsExhausted => governor.credits_exhausted(),
                _ => {}
            }
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

    use binsight_core::clock::FixedClock;
    use binsight_core::credits::{CallOutcome, Credits, Priority, Purpose};
    use binsight_solana::Signature;
    use jiff::Timestamp;
    use tokio::time::Instant;

    use super::*;
    use crate::error::BudgetRefusal;
    use crate::rpc::TransactionLookup;
    use crate::test_support::{ScriptedReply, ScriptedTransport, scripted_client};

    fn context(priority: Priority) -> CallContext {
        CallContext {
            priority,
            purpose: Purpose::TransactionFetch,
            wallet: None,
        }
    }

    fn client(transport: &Arc<ScriptedTransport>) -> RpcClient {
        client_with_limit(transport, None)
    }

    fn client_with_limit(transport: &Arc<ScriptedTransport>, limit: Option<u64>) -> RpcClient {
        let clock = Arc::new(FixedClock::new(
            Timestamp::from_second(1_790_000_000).unwrap(),
        ));
        scripted_client(transport.clone(), clock, limit.map(Credits))
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
    async fn counts_each_attempt_with_its_outcome() {
        let transport = ScriptedTransport::new();
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::Http {
                status: 429,
                retry_after: None,
                body: "slow down".to_owned(),
            });
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::Null);
        let client = client(&transport);

        client
            .transaction(Signature::from_bytes([1; 64]), context(Priority::History))
            .await
            .unwrap();

        let mut outcomes: Vec<(CallOutcome, u64, Credits)> = client
            .credit_meter()
            .drain()
            .into_iter()
            .map(|usage| (usage.outcome, usage.calls, usage.credits))
            .collect();
        outcomes.sort();
        assert_eq!(
            outcomes,
            vec![
                (CallOutcome::Ok, 1, Credits(1)),
                (CallOutcome::RateLimited, 1, Credits(1))
            ]
        );
        assert_eq!(client.credit_meter().spent_today(), Credits(2));
    }

    #[tokio::test(start_paused = true)]
    async fn sends_nothing_once_the_daily_hard_limit_is_reached() {
        let transport = ScriptedTransport::new();
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::Null);
        let client = client_with_limit(&transport, Some(1));
        let fetch =
            || client.transaction(Signature::from_bytes([1; 64]), context(Priority::Realtime));

        assert_eq!(fetch().await, Ok(TransactionLookup::NotFound));
        let refused = fetch().await;

        assert!(matches!(
            refused,
            Err(RpcError::Budget(
                BudgetRefusal::DailyHardLimitReached { .. }
            ))
        ));
        assert_eq!(transport.calls().len(), 1);
    }
}
