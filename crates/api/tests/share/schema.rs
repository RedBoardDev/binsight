//! The share wire contract keeps authentication, explicit nulls and source quality.

#[path = "../positions_native/source.rs"]
mod source;

use super::common;
use axum::http::StatusCode;
use common::{TestApp, TestAppOptions};
use source::{NativePositions, id};
use std::sync::Arc;

#[test]
fn documents_authenticated_share_cards_with_required_nullable_state_fields() {
    let spec: serde_json::Value =
        serde_json::from_str(&binsight_api::openapi::spec_json()).unwrap();
    let route = spec
        .get("paths")
        .unwrap()
        .get("/api/v1/share/positions/{position_id}")
        .unwrap()
        .get("get")
        .unwrap();
    assert_eq!(route.get("operationId").unwrap(), "getPositionShareCard");
    assert_eq!(
        route.pointer("/security/0/session_cookie").unwrap(),
        &serde_json::json!([])
    );
    assert_eq!(
        route
            .pointer("/responses/200/content/application~1json/schema/$ref")
            .unwrap(),
        "#/components/schemas/PositionShareCard"
    );
    let currency = route
        .get("parameters")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .find(|parameter| parameter.get("name").is_some_and(|name| name == "currency"))
        .unwrap();
    assert_eq!(currency.get("required").unwrap(), false);
    for name in ["OpenPositionShareCard", "ClosedPositionShareCard"] {
        let schema = spec
            .pointer(&format!("/components/schemas/{name}"))
            .unwrap();
        let required = schema.get("required").unwrap().as_array().unwrap();
        assert_eq!(required.len(), 16);
        for field in ["strategy", "closed_at", "bins", "range", "held_seconds"] {
            assert!(required.iter().any(|item| item == field), "{name}/{field}");
        }
        let nullable = if name == "OpenPositionShareCard" {
            vec!["strategy", "closed_at"]
        } else {
            vec!["strategy", "bins", "range"]
        };
        for field in nullable {
            let property = schema.pointer(&format!("/properties/{field}")).unwrap();
            let allows_null = property
                .get("type")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|types| types.iter().any(|kind| kind == "null"))
                || property
                    .get("oneOf")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|variants| {
                        variants
                            .iter()
                            .any(|variant| variant.get("type").is_some_and(|kind| kind == "null"))
                    });
            assert!(allows_null, "{name}/{field}");
        }
    }
}

#[tokio::test]
async fn preserves_missing_fx_with_exactly_one_position_read_per_card() {
    let source = Arc::new(NativePositions::new());
    let app = TestApp::with(TestAppOptions {
        read_model: Some(source.clone()),
        ..TestAppOptions::default()
    })
    .await;
    for byte in [1, 2, 10, 11] {
        let card = app
            .get_signed_in(&format!(
                "/api/v1/share/positions/{}?currency=sol",
                id(byte)
            ))
            .await;
        assert_eq!(card.status, StatusCode::OK);
        let card = card.json();
        assert_eq!(card["pnl"]["exactness"], "unavailable");
        assert!(card["pnl"].get("value").is_none());
        assert!(
            card["pnl"]["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|reason| reason["code"] == "no_usd_rate")
        );
    }
    assert_eq!(source.reads(), 4);
    assert_eq!((app.network_io)(), (0, 0));
}
