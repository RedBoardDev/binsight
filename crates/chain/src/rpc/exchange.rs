//! What one request-and-answer exchange with the provider means.
//!
//! The provider speaks on two levels: the HTTP status (429 for "too fast" or "quota used up",
//! 401/403 for the key or the plan, 5xx for its own failures) and, inside a 200, the JSON-RPC
//! result or error code. This module turns both into a result or an [`RpcError`], purely; it
//! does not retry or count anything.

use crate::error::{RpcError, TransportError};
use crate::rpc::envelope::{RpcAnswer, RpcResult, parse_answer};
use crate::rpc::method::RpcMethod;
use crate::rpc::transport::HttpReply;

/// The node cannot return a transaction this new (`maxSupportedTransactionVersion` too low).
const UNSUPPORTED_TRANSACTION_VERSION: i64 = -32015;

/// The node is behind the cluster, or the block is not available on it yet.
const NODE_BEHIND_CODES: [i64; 5] = [-32004, -32005, -32007, -32014, -32016];

/// The node or the provider rejected the request as malformed.
const INVALID_REQUEST_CODES: [i64; 3] = [-32600, -32601, -32602];

/// Helius' JSON-RPC code for a request refused for rate or quota reasons.
const PROVIDER_LIMIT_CODE: i64 = -32429;

/// How one attempt ended.
#[derive(Debug)]
pub(crate) enum Exchange {
    /// The provider answered.
    Replied(HttpReply),
    /// No answer arrived before the deadline.
    TimedOut,
    /// The request could not be exchanged.
    Failed(TransportError),
}

impl Exchange {
    /// The result the exchange carries, or why it failed.
    pub(crate) fn into_result(self, method: RpcMethod) -> Result<RpcResult, RpcError> {
        match self {
            Self::TimedOut => Err(RpcError::Timeout),
            Self::Failed(error) => Err(RpcError::Transport(error)),
            Self::Replied(reply) => read_reply(&reply, method),
        }
    }
}

fn read_reply(reply: &HttpReply, method: RpcMethod) -> Result<RpcResult, RpcError> {
    if reply.status != 200 {
        return Err(http_status_error(reply, method));
    }
    match parse_answer(&reply.body) {
        Ok(RpcAnswer::Result(result)) => Ok(result),
        Ok(RpcAnswer::Error { code, message }) => Err(json_rpc_error(code, message, method)),
        Err(error) => Err(RpcError::UnexpectedResponse {
            method: method.name(),
            detail: error.to_string(),
        }),
    }
}

/// The meaning of a non-200 HTTP status.
fn http_status_error(reply: &HttpReply, method: RpcMethod) -> RpcError {
    let body = String::from_utf8_lossy(&reply.body).to_lowercase();
    match reply.status {
        429 if mentions_quota(&body) => RpcError::CreditsExhausted,
        429 => RpcError::RateLimited {
            retry_after: reply.retry_after,
        },
        403 if body.contains("plan") => RpcError::NotAvailableOnPlan {
            method: method.name(),
        },
        401 | 403 => RpcError::Unauthorized,
        500..=599 => RpcError::ServerError {
            status: reply.status,
        },
        status => RpcError::UnexpectedStatus { status },
    }
}

/// The meaning of a JSON-RPC error code.
fn json_rpc_error(code: i64, message: String, method: RpcMethod) -> RpcError {
    let lowercase = message.to_lowercase();
    match code {
        UNSUPPORTED_TRANSACTION_VERSION => RpcError::UnsupportedTransactionVersion,
        PROVIDER_LIMIT_CODE if mentions_quota(&lowercase) => RpcError::CreditsExhausted,
        PROVIDER_LIMIT_CODE => RpcError::RateLimited { retry_after: None },
        code if NODE_BEHIND_CODES.contains(&code) => RpcError::NodeBehind { code },
        code if INVALID_REQUEST_CODES.contains(&code) && lowercase.contains("plan") => {
            RpcError::NotAvailableOnPlan {
                method: method.name(),
            }
        }
        code if INVALID_REQUEST_CODES.contains(&code) => RpcError::InvalidRequest { code, message },
        code => RpcError::NodeError { code, message },
    }
}

/// Whether a refusal is about the plan's credits rather than the request rate. Helius says
/// "max usage reached" when the monthly credits are used up.
fn mentions_quota(lowercase_text: &str) -> bool {
    lowercase_text.contains("usage") || lowercase_text.contains("credits")
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn reply(status: u16, body: &str) -> Exchange {
        Exchange::Replied(HttpReply {
            status,
            retry_after: Some(Duration::from_secs(2)),
            body: body.as_bytes().to_vec(),
        })
    }

    fn rpc_error(code: i64, message: &str) -> Exchange {
        reply(
            200,
            &format!(
                r#"{{"jsonrpc":"2.0","id":1,"error":{{"code":{code},"message":"{message}"}}}}"#
            ),
        )
    }

    fn read(exchange: Exchange) -> Result<RpcResult, RpcError> {
        exchange.into_result(RpcMethod::GetTransaction)
    }

    #[test]
    fn classifies_minus_32015_as_an_unsupported_version() {
        let error = read(rpc_error(
            -32015,
            "Transaction version (1) is not supported",
        ))
        .unwrap_err();
        assert_eq!(error, RpcError::UnsupportedTransactionVersion);
    }

    #[test]
    fn tells_a_rate_limit_from_used_up_credits() {
        assert_eq!(
            read(reply(429, "Too many requests")).unwrap_err(),
            RpcError::RateLimited {
                retry_after: Some(Duration::from_secs(2))
            }
        );
        assert_eq!(
            read(reply(
                429,
                r#"{"error":{"code":-32429,"message":"max usage reached"}}"#
            ))
            .unwrap_err(),
            RpcError::CreditsExhausted
        );
        assert_eq!(
            read(rpc_error(-32429, "rate limited")).unwrap_err(),
            RpcError::RateLimited { retry_after: None }
        );
    }

    #[test]
    fn tells_a_refused_key_from_a_method_outside_the_plan() {
        assert_eq!(
            read(reply(401, "Unauthorized")).unwrap_err(),
            RpcError::Unauthorized
        );
        assert_eq!(
            read(reply(
                403,
                "Batch requests are only available for paid plans"
            ))
            .unwrap_err(),
            RpcError::NotAvailableOnPlan {
                method: "getTransaction"
            }
        );
        assert_eq!(
            read(rpc_error(-32600, "not available on the free plan")).unwrap_err(),
            RpcError::NotAvailableOnPlan {
                method: "getTransaction"
            }
        );
    }

    #[test]
    fn classifies_node_and_server_failures() {
        assert_eq!(
            read(rpc_error(
                -32016,
                "Minimum context slot has not been reached"
            ))
            .unwrap_err(),
            RpcError::NodeBehind { code: -32016 }
        );
        assert_eq!(
            read(reply(502, "Bad gateway")).unwrap_err(),
            RpcError::ServerError { status: 502 }
        );
        assert_eq!(
            read(rpc_error(-32602, "Invalid param")).unwrap_err(),
            RpcError::InvalidRequest {
                code: -32602,
                message: "Invalid param".to_owned()
            }
        );
        assert_eq!(
            read(rpc_error(-32603, "Internal error")).unwrap_err(),
            RpcError::NodeError {
                code: -32603,
                message: "Internal error".to_owned()
            }
        );
    }

    #[test]
    fn reports_an_unreadable_answer_with_the_method_name() {
        let error = read(reply(200, "<html>")).unwrap_err();
        assert!(matches!(
            error,
            RpcError::UnexpectedResponse {
                method: "getTransaction",
                ..
            }
        ));
    }

    #[test]
    fn passes_timeouts_and_transport_failures_through() {
        assert_eq!(read(Exchange::TimedOut).unwrap_err(), RpcError::Timeout);
        let failure = TransportError::Connect {
            detail: "refused".to_owned(),
        };
        assert_eq!(
            read(Exchange::Failed(failure.clone())).unwrap_err(),
            RpcError::Transport(failure)
        );
    }
}
