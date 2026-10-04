//! `GET /api/v1/health`: is the server up, which version is it, does its database answer, and do
//! its figures come from the chain or from the demo world?
//!
//! The endpoint is public (container health checks, the web app's about box and its demo badge
//! call it) and answers `503` when the database does not answer, with the same body. This module
//! holds the handler and its wire types, converted explicitly from the engine's types.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use binsight_engine::portfolio::DataSourceKind;
use binsight_engine::{ComponentHealth, EngineHealth};
use serde::Serialize;
use utoipa::ToSchema;

use crate::app::AppState;

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

/// Where the figures the API serves come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DataSource {
    /// The engine, from the chain.
    Chain,
    /// A generated demo world: nothing is tracked and no figure is real.
    Demo,
}

impl From<DataSourceKind> for DataSource {
    fn from(kind: DataSourceKind) -> Self {
        match kind {
            DataSourceKind::Chain => Self::Chain,
            DataSourceKind::Demo => Self::Demo,
        }
    }
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
    /// Where the figures come from.
    pub(crate) data_source: DataSource,
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

impl Health {
    /// The report of an engine with this `health`, serving figures from `data_source`.
    fn new(health: EngineHealth, data_source: DataSourceKind) -> Self {
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
            data_source: data_source.into(),
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
    let health = Health::new(state.engine.health().await, state.engine.data_source());
    let status = match health.status {
        HealthStatus::Ok => StatusCode::OK,
        HealthStatus::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, Json(health))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_unavailable_when_the_database_does_not_answer() {
        let health = Health::new(
            EngineHealth {
                database: ComponentHealth::Unavailable,
                engine: binsight_engine::EngineStatus::Running,
            },
            DataSourceKind::Chain,
        );

        assert_eq!(health.status, HealthStatus::Unavailable);
        assert_eq!(health.database, ComponentStatus::Unavailable);
        assert_eq!(health.engine, EngineStatus::Running);
        assert_eq!(health.data_source, DataSource::Chain);
    }

    #[test]
    fn says_when_the_figures_come_from_the_demo_world() {
        let health = Health::new(
            EngineHealth {
                database: ComponentHealth::Ok,
                engine: binsight_engine::EngineStatus::Running,
            },
            DataSourceKind::Demo,
        );

        assert_eq!(
            serde_json::to_value(&health).unwrap()["data_source"],
            "demo"
        );
    }
}
