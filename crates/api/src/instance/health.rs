//! `GET /api/v1/health`: is the server up, which version is it, does its database answer, and do
//! its figures come from the chain or from the demo world?
//!
//! The endpoint is public (container health checks and the web app's about box call it) and
//! answers `503` when the database or a required network component is unavailable, with the same body. This module holds the
//! handler and its wire types, converted explicitly from the engine's types.

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
    /// Latest RPC attempt without a probe; null when the application runs no engine.
    #[schema(required = true)]
    pub(crate) rpc: Option<RpcStatus>,
    /// Latest connection/subscription facts; null when the application runs no engine.
    #[schema(required = true)]
    pub(crate) stream: Option<StreamStatus>,
    /// Actual provider credits; null when this application runs no engine.
    #[schema(required = true)]
    pub(crate) credits: Option<CreditHealth>,
    /// Where the figures come from.
    pub(crate) data_source: DataSource,
}

/// Actual credits admitted by the engine's provider governor, without issuing a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct CreditHealth {
    /// Credits spent today (UTC).
    today_used: u64,
    /// Today's remaining allowance under the current billing cycle.
    daily_allowance: u64,
    /// Credits spent in the billing cycle.
    cycle_used: u64,
    /// Credits granted by the billing cycle.
    quota: u64,
    /// Whether every request is currently refused by a hard governor limit.
    hard_limit_reached: bool,
}

impl From<binsight_engine::CreditHealth> for CreditHealth {
    fn from(credits: binsight_engine::CreditHealth) -> Self {
        Self {
            today_used: credits.today_used.0,
            daily_allowance: credits.daily_allowance.0,
            cycle_used: credits.cycle_used.0,
            quota: credits.quota.0,
            hard_limit_reached: credits.hard_limit_reached,
        }
    }
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
        let status = if health.rpc == Some(binsight_engine::RpcHealth::Unavailable)
            || health.stream == Some(binsight_engine::StreamHealth::Unavailable)
        {
            HealthStatus::Unavailable
        } else {
            status
        };
        Self {
            status,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            database,
            engine: health.engine.into(),
            rpc: health.rpc.map(Into::into),
            stream: health.stream.map(Into::into),
            credits: health.credits.map(Into::into),
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
        (status = 200, description = "The server and its required components answer.", body = Health),
        (status = 503, description = "A required component is unavailable.", body = Health),
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
#[path = "health/tests.rs"]
mod tests;
