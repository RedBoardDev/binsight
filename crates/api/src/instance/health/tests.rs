//! Health verdicts: only the database makes the server unavailable.

use super::*;

fn chain_health(
    database: ComponentHealth,
    rpc: binsight_engine::RpcHealth,
    stream: binsight_engine::StreamHealth,
) -> Health {
    Health::new(
        EngineHealth {
            database,
            engine: binsight_engine::EngineStatus::Running,
            rpc: Some(rpc),
            stream: Some(stream),
        },
        DataSourceKind::Chain,
    )
}

#[test]
fn reports_a_provider_or_stream_outage_as_degraded_not_unavailable() {
    for (rpc, stream) in [
        (
            binsight_engine::RpcHealth::Unavailable,
            binsight_engine::StreamHealth::Connected,
        ),
        (
            binsight_engine::RpcHealth::Ok,
            binsight_engine::StreamHealth::Unavailable,
        ),
    ] {
        let report = chain_health(ComponentHealth::Ok, rpc, stream);
        assert_eq!(report.status, HealthStatus::Degraded);
        assert_eq!(report.database, ComponentStatus::Ok);
    }
}

#[test]
fn stays_healthy_for_container_checks_while_only_the_provider_is_down() {
    assert_eq!(status_code(HealthStatus::Ok), StatusCode::OK);
    assert_eq!(status_code(HealthStatus::Degraded), StatusCode::OK);
    assert_eq!(
        status_code(HealthStatus::Unavailable),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[test]
fn reports_unavailable_when_the_database_does_not_answer() {
    let health = chain_health(
        ComponentHealth::Unavailable,
        binsight_engine::RpcHealth::Unavailable,
        binsight_engine::StreamHealth::Idle,
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
            rpc: None,
            stream: None,
        },
        DataSourceKind::Demo,
    );

    assert_eq!(
        serde_json::to_value(&health).unwrap()["data_source"],
        "demo"
    );
}
