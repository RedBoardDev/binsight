//! The health of the engine and of what it depends on, as reported to the health endpoint.
//!
//! A health check must answer quickly even when something is stuck, so the database check has a
//! short deadline: a database that does not answer in time is reported as unavailable. The
//! credits come from the chain client's meter, in memory. This module defines the report and how
//! a database check result and the meter's standing map to it.

use std::time::Duration;

use binsight_chain::{CreditStanding, StreamSnapshot, SubscriptionStatus};
use binsight_core::credits::CallOutcome;
use binsight_core::credits::Credits;
use binsight_store::{Store, StoreError};
use tracing::warn;

use crate::status::EngineStatus;

/// How long the database may take to answer a health check.
const DATABASE_CHECK_TIMEOUT_SECS: u64 = 2;

/// Whether a component the engine relies on works.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComponentHealth {
    /// It answers normally.
    Ok,
    /// It failed or did not answer in time.
    Unavailable,
}

/// Where the RPC provider's credits stand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreditHealth {
    /// The credits spent today (UTC).
    pub today_used: Credits,
    /// What today may spend: the billing cycle's usable credits left, spread over its days.
    pub daily_allowance: Credits,
    /// The credits spent in the current billing cycle.
    pub cycle_used: Credits,
    /// The credits the billing cycle grants.
    pub quota: Credits,
    /// Whether a hard limit (the daily limit, or the cycle's credits) stops every request.
    pub hard_limit_reached: bool,
}

impl From<CreditStanding> for CreditHealth {
    fn from(standing: CreditStanding) -> Self {
        Self {
            today_used: standing.spent_today,
            daily_allowance: standing.daily_allowance,
            cycle_used: standing.spent_cycle,
            quota: standing.cycle_credits,
            hard_limit_reached: standing.is_refusing_all,
        }
    }
}

/// The result of the latest completed RPC attempt, without issuing a health probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RpcHealth {
    /// No attempt has finished yet, including when ingestion is disabled.
    Unknown,
    /// The provider answered a successful request.
    Ok,
    /// The latest attempt failed or was refused.
    Unavailable,
}

impl From<Option<CallOutcome>> for RpcHealth {
    fn from(outcome: Option<CallOutcome>) -> Self {
        match outcome {
            None | Some(CallOutcome::Cancelled) => Self::Unknown,
            Some(CallOutcome::Ok) => Self::Ok,
            Some(_) => Self::Unavailable,
        }
    }
}

/// Connection and subscription health, independent of the lossy activity channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamHealth {
    /// No wallet needs a connection.
    Idle,
    /// Watched wallets are waiting for their first connection or acknowledgement.
    Connecting,
    /// Every watched wallet is subscribed on an open connection.
    Connected,
    /// A connection or subscription failed or was refused.
    Unavailable,
}

impl From<StreamSnapshot> for StreamHealth {
    fn from(snapshot: StreamSnapshot) -> Self {
        if snapshot.watched.is_empty() {
            return Self::Idle;
        }
        if snapshot.disconnect_reason.is_some()
            || snapshot
                .subscriptions
                .values()
                .any(|status| matches!(status, SubscriptionStatus::Refused { .. }))
        {
            return Self::Unavailable;
        }
        if snapshot.is_connected
            && snapshot.watched.iter().all(|wallet| {
                snapshot.subscriptions.get(wallet) == Some(&SubscriptionStatus::Subscribed)
            })
        {
            return Self::Connected;
        }
        Self::Connecting
    }
}

/// The health of the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineHealth {
    /// Whether the database answers.
    pub database: ComponentHealth,
    /// Where the engine is in its lifecycle.
    pub engine: EngineStatus,
    /// Where actual RPC credits stand; absent when ingestion has no provider.
    pub credits: Option<CreditHealth>,
    /// Latest completed RPC result without a probe; absent when there is no transport.
    pub rpc: Option<RpcHealth>,
    /// Latest connection/subscription facts; absent when there is no transport.
    pub stream: Option<StreamHealth>,
}

/// Pings the database with a deadline.
pub(crate) async fn check_database(store: &Store) -> ComponentHealth {
    let deadline = Duration::from_secs(DATABASE_CHECK_TIMEOUT_SECS);
    database_health(tokio::time::timeout(deadline, store.ping()).await.ok())
}

/// Maps the outcome of a ping (`None` when it timed out) to a health status.
fn database_health(ping: Option<Result<(), StoreError>>) -> ComponentHealth {
    match ping {
        Some(Ok(())) => ComponentHealth::Ok,
        Some(Err(error)) => {
            warn!(%error, "the database failed its health check");
            ComponentHealth::Unavailable
        }
        None => {
            warn!(
                timeout_secs = DATABASE_CHECK_TIMEOUT_SECS,
                "the database did not answer its health check in time"
            );
            ComponentHealth::Unavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_health_is_factual_for_idle_connecting_connected_and_refused_wallets() {
        use binsight_solana::Address;
        let wallet = Address::from_bytes([1; 32]);
        let mut snapshot = StreamSnapshot::default();
        assert_eq!(StreamHealth::from(snapshot.clone()), StreamHealth::Idle);
        snapshot.watched.insert(wallet);
        assert_eq!(
            StreamHealth::from(snapshot.clone()),
            StreamHealth::Connecting
        );
        snapshot.is_connected = true;
        snapshot
            .subscriptions
            .insert(wallet, SubscriptionStatus::Subscribed);
        assert_eq!(
            StreamHealth::from(snapshot.clone()),
            StreamHealth::Connected
        );
        snapshot.subscriptions.insert(
            wallet,
            SubscriptionStatus::Refused {
                code: -32000,
                message: "subscription refused".to_owned(),
            },
        );
        assert_eq!(StreamHealth::from(snapshot), StreamHealth::Unavailable);
    }

    #[test]
    fn reports_a_database_that_answers_as_ok() {
        assert_eq!(database_health(Some(Ok(()))), ComponentHealth::Ok);
    }

    #[test]
    fn reports_a_failing_or_silent_database_as_unavailable() {
        let failure = StoreError::TaskInterrupted;
        assert_eq!(
            database_health(Some(Err(failure))),
            ComponentHealth::Unavailable
        );
        assert_eq!(database_health(None), ComponentHealth::Unavailable);
    }
}
