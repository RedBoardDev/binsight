//! Health serialization and verdicts for real and absent transports.

use binsight_core::credits::Credits;

use super::*;

#[test]
fn reports_the_latest_rpc_and_subscription_failures_without_a_network_probe() {
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
        let report = Health::new(
            EngineHealth {
                database: ComponentHealth::Ok,
                engine: binsight_engine::EngineStatus::Running,
                rpc: Some(rpc),
                stream: Some(stream),
                credits: Some(binsight_engine::CreditHealth {
                    today_used: Credits(0),
                    daily_allowance: Credits(0),
                    cycle_used: Credits(0),
                    quota: Credits(1_000_000),
                    hard_limit_reached: false,
                }),
            },
            DataSourceKind::Chain,
        );
        assert_eq!(report.status, HealthStatus::Unavailable);
    }
}

#[test]
fn reports_unavailable_when_the_database_does_not_answer() {
    let health = Health::new(
        EngineHealth {
            database: ComponentHealth::Unavailable,
            rpc: Some(binsight_engine::RpcHealth::Unknown),
            stream: Some(binsight_engine::StreamHealth::Idle),
            engine: binsight_engine::EngineStatus::Running,
            credits: Some(binsight_engine::CreditHealth {
                today_used: Credits(0),
                daily_allowance: Credits(30_645),
                cycle_used: Credits(0),
                quota: Credits(1_000_000),
                hard_limit_reached: false,
            }),
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
            credits: None,
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
