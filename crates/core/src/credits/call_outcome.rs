//! How one RPC request ended, as counted by the credit meter.
//!
//! Every request sent is counted, whatever its outcome, because the provider may bill it; the
//! outcome says which ones were wasted. This module only names the outcomes; the chain client
//! classifies each answer.

use std::fmt;
use std::str::FromStr;

use crate::error::UnknownName;

/// The outcome of one request sent to the RPC provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CallOutcome {
    /// The node answered with a result (possibly `null`).
    Ok,
    /// The node answered with a JSON-RPC error.
    RpcError,
    /// The provider refused the request because of its rate or its quota (HTTP 429).
    RateLimited,
    /// The provider answered with another HTTP error status.
    HttpError,
    /// No answer arrived before the deadline.
    Timeout,
    /// The connection failed before an answer arrived.
    NetworkError,
    /// The request was abandoned before its answer arrived, at shutdown; the provider may still
    /// bill it.
    Cancelled,
}

impl CallOutcome {
    /// Every outcome.
    pub const ALL: [Self; 7] = [
        Self::Ok,
        Self::RpcError,
        Self::RateLimited,
        Self::HttpError,
        Self::Timeout,
        Self::NetworkError,
        Self::Cancelled,
    ];

    /// The stable `snake_case` name, as stored and shown.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::RpcError => "rpc_error",
            Self::RateLimited => "rate_limited",
            Self::HttpError => "http_error",
            Self::Timeout => "timeout",
            Self::NetworkError => "network_error",
            Self::Cancelled => "cancelled",
        }
    }
}

impl FromStr for CallOutcome {
    type Err = UnknownName;

    /// Reads a name written by [`CallOutcome::as_str`].
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|outcome| outcome.as_str() == text)
            .ok_or_else(|| UnknownName::new("call outcome", text))
    }
}

impl fmt::Display for CallOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_outcome_through_its_name() {
        for outcome in CallOutcome::ALL {
            assert_eq!(outcome.as_str().parse::<CallOutcome>(), Ok(outcome));
        }
        assert!("fine".parse::<CallOutcome>().is_err());
    }
}
