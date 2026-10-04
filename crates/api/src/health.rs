//! `GET /api/v1/health`: is the server up, which version is it, and does its database answer?
//!
//! The endpoint is public (container health checks and the web app's about box call it) and
//! answers `503` when the database does not answer, with the same body. This module holds the
//! handler and its wire types, converted explicitly from the engine's types.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use binsight_engine::{ComponentHealth, EngineHealth};
use serde::Serialize;
use utoipa::ToSchema;

use crate::state::AppState;

/// The overall verdict of a health check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HealthStatus {
    /// Everything answers.
    Ok,
    /// Something binsight needs does not answer.
    Unavailable,
}

/// Whether one component answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComponentStatus {
    /// It answers.
    Ok,
    /// It failed or did not answer in time.
    Unavailable,
}

/// Where the engine is in its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EngineStatus {
    /// Starting up.
    Starting,
    /// Running normally.
    Running,
    /// Shutting down.
    Stopping,
}

/// The health report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Health {
    /// `ok` when every component answers.
    pub(crate) status: HealthStatus,
    /// The binsight version, for example `0.1.0`.
    pub(crate) version: String,
    /// Whether the database answers.
    pub(crate) database: ComponentStatus,
    /// Where the engine is in its lifecycle.
    pub(crate) engine: EngineStatus,
}

impl From<binsight_engine::EngineStatus> for EngineStatus {
    fn from(status: binsight_engine::EngineStatus) -> Self {
        match status {
            binsight_engine::EngineStatus::Starting => Self::Starting,
            binsight_engine::EngineStatus::Running => Self::Running,
            binsight_engine::EngineStatus::Stopping => Self::Stopping,
        }
    }
}

impl From<EngineHealth> for Health {
    fn from(health: EngineHealth) -> Self {
        let (status, database) = match health.database {
            ComponentHealth::Ok => (HealthStatus::Ok, ComponentStatus::Ok),
            ComponentHealth::Unavailable => {
                (HealthStatus::Unavailable, ComponentStatus::Unavailable)
            }
        };
        Self {
            status,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            database,
            engine: health.engine.into(),
        }
    }
}

/// Reports the health of the server.
#[utoipa::path(
    get,
    path = "/api/v1/health",
    operation_id = "getHealth",
    tag = "system",
    responses(
        (status = 200, description = "The server and its database answer.", body = Health),
        (status = 503, description = "The database does not answer.", body = Health),
    ),
)]
pub(crate) async fn get_health(State(state): State<AppState>) -> (StatusCode, Json<Health>) {
    let health = Health::from(state.engine.health().await);
    let status = match health.status {
        HealthStatus::Ok => StatusCode::OK,
        HealthStatus::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, Json(health))
}

#[cfg(test)]
mod tests {
    use binsight_core::credits::Credits;

    use super::*;

    #[test]
    fn reports_unavailable_when_the_database_does_not_answer() {
        let health = Health::from(EngineHealth {
            database: ComponentHealth::Unavailable,
            engine: binsight_engine::EngineStatus::Running,
            credits: binsight_engine::CreditHealth {
                today_used: Credits(0),
                daily_allowance: Credits(30_645),
                cycle_used: Credits(0),
                quota: Credits(1_000_000),
                hard_limit_reached: false,
            },
        });

        assert_eq!(health.status, HealthStatus::Unavailable);
        assert_eq!(health.database, ComponentStatus::Unavailable);
        assert_eq!(health.engine, EngineStatus::Running);
    }
}
