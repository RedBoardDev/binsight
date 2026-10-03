//! The health of the engine and of what it depends on, as reported to the health endpoint.
//!
//! A health check must answer quickly even when something is stuck, so the database check has a
//! short deadline: a database that does not answer in time is reported as unavailable. This
//! module defines the report and how a database check result maps to it.

use std::time::Duration;

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

/// The health of the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineHealth {
    /// Whether the database answers.
    pub database: ComponentHealth,
    /// Where the engine is in its lifecycle.
    pub engine: EngineStatus,
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
