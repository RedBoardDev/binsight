//! The one retry policy of the chain client: which failures are worth another attempt, and when.
//!
//! Transient failures (timeouts, rate limits, server errors, a node behind the cluster) are tried
//! again after an exponential backoff with jitter; failures that cannot heal by waiting a few
//! seconds (a refused key, used-up credits, a malformed request, an answer that cannot be read,
//! an unsupported transaction version) are returned at once: the engine tries those again on its
//! own, much slower, schedule. Urgent calls get more attempts than background ones. The jitter is derived from the
//! request id rather than a random generator, so tests are deterministic. This module is pure: it
//! decides, the client waits.

use std::time::Duration;

use binsight_core::credits::Priority;

use crate::error::RpcError;

/// The first backoff delay.
const BASE_BACKOFF_MILLIS: u64 = 250;

/// The longest backoff delay.
const MAX_BACKOFF_MILLIS: u64 = 8_000;

/// The jitter, in percent of the delay, on either side.
const JITTER_PERCENT: u64 = 25;

/// The longest `Retry-After` the client honours; a longer one is capped.
const MAX_RETRY_AFTER_SECS: u64 = 60;

/// Whether to try a failed call again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Retry {
    /// Try again after this delay.
    After(Duration),
    /// Give up and return the error.
    Never,
}

/// How many attempts a call of this class gets in total.
pub(crate) const fn max_attempts(priority: Priority) -> u32 {
    match priority {
        Priority::Realtime | Priority::CatchUp => 4,
        Priority::History => 3,
        Priority::Valuation => 1,
    }
}

/// Decides what to do after attempt number `attempt` (counted from 1) failed with `error`.
/// `request_id` seeds the jitter.
pub(crate) fn decide(error: &RpcError, attempt: u32, priority: Priority, request_id: u64) -> Retry {
    if attempt >= max_attempts(priority) || !is_transient(error) {
        return Retry::Never;
    }
    match error {
        RpcError::RateLimited {
            retry_after: Some(delay),
        } => Retry::After((*delay).min(Duration::from_secs(MAX_RETRY_AFTER_SECS))),
        _ => Retry::After(backoff(attempt, request_id)),
    }
}

/// Whether waiting can make this failure go away.
fn is_transient(error: &RpcError) -> bool {
    match error {
        RpcError::Timeout
        | RpcError::Transport(_)
        | RpcError::RateLimited { .. }
        | RpcError::ServerError { .. }
        | RpcError::NodeBehind { .. }
        | RpcError::NodeError { .. } => true,
        RpcError::CreditsExhausted
        | RpcError::Unauthorized
        | RpcError::NotAvailableOnPlan { .. }
        | RpcError::UnexpectedStatus { .. }
        | RpcError::UnsupportedTransactionVersion
        | RpcError::InvalidRequest { .. }
        | RpcError::UnexpectedResponse { .. } => false,
    }
}

/// `250 ms × 2^(attempt − 1)`, capped at 8 s, moved by up to ±25 % of itself.
fn backoff(attempt: u32, request_id: u64) -> Duration {
    let doublings = attempt.saturating_sub(1);
    let delay = 2_u64
        .checked_pow(doublings)
        .and_then(|factor| factor.checked_mul(BASE_BACKOFF_MILLIS))
        .map_or(MAX_BACKOFF_MILLIS, |millis| millis.min(MAX_BACKOFF_MILLIS));
    let spread = delay.saturating_mul(JITTER_PERCENT) / 100;
    let width = spread.saturating_mul(2).saturating_add(1);
    let offset = jitter_seed(request_id, attempt) % width;
    Duration::from_millis(delay.saturating_sub(spread).saturating_add(offset))
}

/// A well-mixed number from the request id and the attempt (a multiplicative hash).
fn jitter_seed(request_id: u64, attempt: u32) -> u64 {
    let mixed = request_id
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(u64::from(attempt).wrapping_mul(0xBF58_476D_1CE4_E5B9));
    mixed ^ (mixed >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::TransportError;

    fn delay(retry: Retry) -> Duration {
        match retry {
            Retry::After(delay) => delay,
            Retry::Never => panic!("expected a retry"),
        }
    }

    #[test]
    fn doubles_the_backoff_with_a_jitter_of_a_quarter() {
        for (attempt, base_millis) in [(1, 250), (2, 500), (3, 1_000)] {
            for request_id in 0..50 {
                let waited = delay(decide(
                    &RpcError::Timeout,
                    attempt,
                    Priority::CatchUp,
                    request_id,
                ));
                let low = Duration::from_millis(base_millis * 3 / 4);
                let high = Duration::from_millis(base_millis * 5 / 4);
                assert!(waited >= low && waited <= high, "{attempt}: {waited:?}");
            }
        }
    }

    #[test]
    fn caps_the_backoff_at_eight_seconds() {
        assert!(backoff(30, 1) <= Duration::from_millis(10_000));
        assert!(backoff(u32::MAX, 1) <= Duration::from_millis(10_000));
    }

    #[test]
    fn jitters_the_same_way_for_the_same_request() {
        assert_eq!(backoff(2, 42), backoff(2, 42));
    }

    #[test]
    fn respects_retry_after_up_to_a_minute() {
        let asked = RpcError::RateLimited {
            retry_after: Some(Duration::from_secs(3)),
        };
        assert_eq!(
            decide(&asked, 1, Priority::History, 0),
            Retry::After(Duration::from_secs(3))
        );
        let excessive = RpcError::RateLimited {
            retry_after: Some(Duration::from_secs(3_600)),
        };
        assert_eq!(
            decide(&excessive, 1, Priority::History, 0),
            Retry::After(Duration::from_secs(60))
        );
    }

    #[test]
    fn never_retries_what_waiting_cannot_fix() {
        for error in [
            RpcError::Unauthorized,
            RpcError::CreditsExhausted,
            RpcError::UnsupportedTransactionVersion,
            RpcError::NotAvailableOnPlan { method: "x" },
            RpcError::UnexpectedStatus { status: 404 },
            RpcError::InvalidRequest {
                code: -32602,
                message: String::new(),
            },
            RpcError::UnexpectedResponse {
                method: "getTransaction",
                detail: String::new(),
            },
        ] {
            assert_eq!(
                decide(&error, 1, Priority::Realtime, 0),
                Retry::Never,
                "{error}"
            );
        }
    }

    #[test]
    fn gives_each_class_its_number_of_attempts() {
        let error = RpcError::Transport(TransportError::Connect {
            detail: String::new(),
        });
        for (priority, attempts) in [
            (Priority::Realtime, 4),
            (Priority::CatchUp, 4),
            (Priority::History, 3),
            (Priority::Valuation, 1),
        ] {
            let last_retried = attempts - 1;
            if last_retried > 0 {
                assert!(matches!(
                    decide(&error, last_retried, priority, 0),
                    Retry::After(_)
                ));
            }
            assert_eq!(decide(&error, attempts, priority, 0), Retry::Never);
        }
    }
}
