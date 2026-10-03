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
