//! The committed contract `openapi/v1.json` must match the one generated from the code.
//!
//! Run `just openapi` to regenerate it after changing a route or a wire type; this test then
//! rewrites the file (it does so whenever `BINSIGHT_UPDATE_OPENAPI=1` is set).

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod common;

use std::path::PathBuf;

use axum::http::StatusCode;
use common::TestApp;

fn committed_contract_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../openapi/v1.json")
}

#[expect(
    clippy::disallowed_methods,
    reason = "the switch that turns this check into the generator"
)]
fn is_update_requested() -> bool {
    std::env::var_os("BINSIGHT_UPDATE_OPENAPI").is_some_and(|value| value == "1")
}

#[test]
fn matches_the_committed_contract() {
    let generated = binsight_api::openapi::spec_json();
    let path = committed_contract_path();
    if is_update_requested() {
        std::fs::write(&path, &generated).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == generated,
        "openapi/v1.json is out of date: run `just openapi` and commit the result"
    );
}

#[tokio::test]
async fn serves_the_same_contract_over_http() {
    let app = TestApp::new().await;

    let response = app.get("/api/v1/openapi.json").await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        String::from_utf8(response.body.to_vec()).unwrap(),
        binsight_api::openapi::spec_json()
    );
}

#[test]
fn gives_every_operation_a_stable_id() {
    let spec = binsight_api::openapi::spec();
    for (path, item) in &spec.paths.paths {
        for operation in [&item.get, &item.post, &item.put, &item.delete, &item.patch]
            .into_iter()
            .flatten()
        {
            assert!(
                operation.operation_id.is_some(),
                "{path} has no operationId"
            );
        }
    }
}

#[test]
fn requires_nullable_import_progress_on_every_public_surface() {
    let spec: serde_json::Value =
        serde_json::from_str(&binsight_api::openapi::spec_json()).unwrap();
    for name in ["ImportProgress", "ImportingWallet", "Reason", "WatchItem"] {
        let schema = spec
            .pointer(&format!("/components/schemas/{name}"))
            .unwrap();
        let object = schema.get("oneOf").map_or(schema, |variants| {
            variants
                .as_array()
                .unwrap()
                .iter()
                .find(|variant| variant.pointer("/properties/progress").is_some())
                .unwrap()
        });
        assert!(
            object
                .get("required")
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .any(|field| field == "progress"),
            "{name} must require explicit progress"
        );
        let variants = object
            .pointer("/properties/progress/oneOf")
            .unwrap()
            .as_array()
            .unwrap();
        assert!(variants.iter().any(|variant| {
            variant
                .get("$ref")
                .is_some_and(|reference| reference == "#/components/schemas/DecimalString")
        }));
        assert!(
            variants
                .iter()
                .any(|variant| { variant.get("type").is_some_and(|kind| kind == "null") })
        );
    }
}

#[test]
fn keeps_the_v1_fee_count_integer_and_requires_the_v2_nullable_count() {
    let spec: serde_json::Value =
        serde_json::from_str(&binsight_api::openapi::spec_json()).unwrap();
    for (version, operation, response, summary, nullable) in [
        ("v1", "getOverview", "Overview", "OpenSummary", false),
        ("v2", "getOverviewV2", "OverviewV2", "OpenSummaryV2", true),
    ] {
        let route = spec
            .get("paths")
            .unwrap()
            .get(format!("/api/{version}/overview"))
            .unwrap()
            .get("get")
            .unwrap();
        assert_eq!(route.get("operationId").unwrap(), operation);
        assert_eq!(
            route
                .pointer("/responses/200/content/application~1json/schema/$ref")
                .unwrap(),
            &format!("#/components/schemas/{response}")
        );
        let schema = spec
            .pointer(&format!("/components/schemas/{summary}"))
            .unwrap();
        let object = schema.get("allOf").map_or(schema, |parts| {
            parts
                .as_array()
                .unwrap()
                .iter()
                .find(|part| {
                    part.pointer("/properties/unclaimed_position_count")
                        .is_some()
                })
                .unwrap()
        });
        assert!(
            object
                .get("required")
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .any(|field| field == "unclaimed_position_count")
        );
        let property = object
            .pointer("/properties/unclaimed_position_count")
            .unwrap();
        if nullable {
            let types = property.get("type").unwrap().as_array().unwrap();
            assert_eq!(types.len(), 2);
            assert!(types.iter().any(|kind| kind == "integer"));
            assert!(types.iter().any(|kind| kind == "null"));
        } else {
            assert_eq!(property.get("type").unwrap(), "integer");
        }
        assert_eq!(property.get("minimum").unwrap(), 0);
    }
}

#[test]
fn requires_shared_external_links_on_position_and_wallet_references() {
    let spec: serde_json::Value =
        serde_json::from_str(&binsight_api::openapi::spec_json()).unwrap();
    for (name, target) in [
        ("OpenPositionRow", "PositionLinks"),
        ("ClosedPositionRow", "PositionLinks"),
        ("WalletRef", "WalletLinks"),
    ] {
        let schema = spec
            .pointer(&format!("/components/schemas/{name}"))
            .unwrap();
        assert!(
            schema
                .get("required")
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .any(|field| field == "links")
        );
        assert_eq!(
            schema.pointer("/properties/links/$ref").unwrap(),
            &format!("#/components/schemas/{target}")
        );
    }
    for (name, fields) in [
        ("PositionLinks", vec!["meteora", "solscan", "gmgn"]),
        ("WalletLinks", vec!["jupiter_portfolio", "solscan"]),
    ] {
        let schema = spec
            .pointer(&format!("/components/schemas/{name}"))
            .unwrap();
        let required = schema.get("required").unwrap().as_array().unwrap();
        assert_eq!(required.len(), fields.len());
        for field in fields {
            assert!(required.iter().any(|item| item == field));
            assert_eq!(
                schema
                    .pointer(&format!("/properties/{field}/type"))
                    .unwrap(),
                "string"
            );
        }
    }
}

#[test]
fn requires_native_pnl_only_in_position_details_without_changing_the_read_operation() {
    let spec: serde_json::Value =
        serde_json::from_str(&binsight_api::openapi::spec_json()).unwrap();
    assert_eq!(spec.pointer("/info/version").unwrap(), "1.9.0");
    for name in ["OpenPositionDetail", "ClosedPositionDetail"] {
        let schema = spec
            .pointer(&format!("/components/schemas/{name}"))
            .unwrap();
        let object = schema
            .get("allOf")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|part| part.pointer("/properties/native_pnl").is_some())
            .unwrap();
        assert!(
            object
                .get("required")
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .any(|field| field == "native_pnl")
        );
        assert_eq!(
            object.pointer("/properties/native_pnl/$ref").unwrap(),
            "#/components/schemas/Figure"
        );
    }
    for name in [
        "OpenPositionRow",
        "ClosedPositionRow",
        "OpenTotals",
        "ClosedTotals",
    ] {
        let schema = spec
            .pointer(&format!("/components/schemas/{name}"))
            .unwrap();
        assert!(schema.pointer("/properties/native_pnl").is_none());
    }
    let operation = spec
        .get("paths")
        .unwrap()
        .get("/api/v1/positions/{position_id}")
        .unwrap()
        .get("get")
        .unwrap();
    assert_eq!(operation.get("operationId").unwrap(), "getPosition");
    assert_eq!(
        spec.get("paths")
            .unwrap()
            .as_object()
            .unwrap()
            .values()
            .map(|path| path
                .as_object()
                .unwrap()
                .values()
                .filter(|operation| operation.get("operationId").is_some())
                .count())
            .sum::<usize>(),
        21
    );
}
