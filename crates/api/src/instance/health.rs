//! `GET /api/v1/health`: is the server up, which version is it, does its database answer, and do
//! its figures come from the chain or from the demo world?
//!
//! The endpoint is public (container health checks and the web app's about box call it). It
//! answers `503` only when the database does not answer: that is the server's own failure, which
//! a restart may cure. A provider or stream outage is the provider's problem; restarting binsight
//! would not help, so the server stays healthy (`200`) and reports `degraded` in the body. The
//! credits spent are the owner's business and are only served behind the session (`GET /sync`).
//! This module holds the handler and its wire types, converted explicitly from the engine's
//! types.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use binsight_engine::portfolio::DataSourceKind;
use binsight_engine::{ComponentHealth, EngineHealth};
use serde::Serialize;
use utoipa::ToSchema;

mod network;

use network::{RpcStatus, StreamStatus};

use crate::app::AppState;

/// The overall verdict of a health check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HealthStatus {
    /// Everything answers.
    Ok,
    /// The server works, but the provider or its stream does not answer: figures may lag.
    Degraded,
    /// The database does not answer.
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
    /// `ok` when every component answers, `degraded` when only the provider or its stream does
    /// not, `unavailable` when the database does not.
    pub(crate) status: HealthStatus,
    /// The binsight version, for example `0.1.0`.
    pub(crate) version: String,
    /// Whether the database answers.
    pub(crate) database: ComponentStatus,
    /// Where the engine is in its lifecycle.
    pub(crate) engine: EngineStatus,
    /// Latest RPC attempt without a probe; null when the application runs no engine.
    #[schema(required = true)]
    pub(crate) rpc: Option<RpcStatus>,
    /// Latest connection/subscription facts; null when the application runs no engine.
    #[schema(required = true)]
    pub(crate) stream: Option<StreamStatus>,
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
        let is_provider_down = health.rpc == Some(binsight_engine::RpcHealth::Unavailable)
            || health.stream == Some(binsight_engine::StreamHealth::Unavailable);
        let (status, database) = match (health.database, is_provider_down) {
            (ComponentHealth::Unavailable, _) => {
                (HealthStatus::Unavailable, ComponentStatus::Unavailable)
            }
            (ComponentHealth::Ok, true) => (HealthStatus::Degraded, ComponentStatus::Ok),
            (ComponentHealth::Ok, false) => (HealthStatus::Ok, ComponentStatus::Ok),
        };
        Self {
            status,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            database,
            engine: health.engine.into(),
            rpc: health.rpc.map(Into::into),
            stream: health.stream.map(Into::into),
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
        (status = 200, description = "The server works; `status` says whether the provider answers too (`ok`) or not (`degraded`).", body = Health),
        (status = 503, description = "The database does not answer (`status` is `unavailable`).", body = Health),
    ),
)]
pub(crate) async fn get_health(State(state): State<AppState>) -> (StatusCode, Json<Health>) {
    let health = Health::new(state.engine.health().await, state.engine.data_source());
    (status_code(health.status), Json(health))
}

/// The HTTP status of a verdict: only an unavailable server answers `503`.
fn status_code(status: HealthStatus) -> StatusCode {
    match status {
        HealthStatus::Ok | HealthStatus::Degraded => StatusCode::OK,
        HealthStatus::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
    }
}

#[cfg(test)]
#[path = "health/tests.rs"]
mod tests;
