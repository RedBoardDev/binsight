//! `GET /api/v1/health` against a real engine and database.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod common;

use axum::http::StatusCode;
use common::{TestApp, TestAppOptions};

#[tokio::test]
async fn reports_a_healthy_server_with_its_version() {
    let app = TestApp::new().await;

    let response = app.get("/api/v1/health").await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.header("content-type"), Some("application/json"));
    insta::assert_json_snapshot!(response.json(), { ".version" => "[version]" }, @r#"
    {
      "data_source": "chain",
      "database": "ok",
      "engine": "starting",
      "status": "ok",
      "version": "[version]"
    }
    "#);
}

#[tokio::test]
async fn reports_the_version_of_the_binary() {
    let app = TestApp::new().await;

    let response = app.get("/api/v1/health").await;

    assert_eq!(response.json()["version"], env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn tags_every_response_with_a_request_id_and_security_headers() {
    let app = TestApp::new().await;

    let response = app.get("/api/v1/health").await;

    let request_id = response.header("x-request-id").unwrap();
    assert_eq!(request_id.len(), 36, "a UUID: {request_id}");
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(response.header("x-frame-options"), Some("DENY"));
    assert_eq!(response.header("referrer-policy"), Some("same-origin"));
    assert_eq!(
        response.header("cross-origin-opener-policy"),
        Some("same-origin")
    );
    assert!(
        response
            .header("permissions-policy")
            .unwrap()
            .contains("camera=()")
    );
    assert_eq!(response.header("strict-transport-security"), None);
    assert!(
        response
            .header("content-security-policy")
            .unwrap()
            .starts_with("default-src 'self'")
    );
}

#[tokio::test]
async fn asks_browsers_for_https_only_behind_an_https_public_url() {
    let app = TestApp::with(TestAppOptions {
        public_url: Some("https://binsight.example.com"),
        ..TestAppOptions::default()
    })
    .await;

    let response = app.get("/api/v1/health").await;

    assert_eq!(
        response.header("strict-transport-security"),
        Some("max-age=31536000")
    );
}

#[tokio::test]
async fn keeps_the_request_id_a_proxy_already_set() {
    let app = TestApp::new().await;
    let request = axum::http::Request::get("/api/v1/health")
        .header("x-request-id", "from-the-proxy")
        .body(axum::body::Body::empty())
        .unwrap();

    let response = app.send(request).await;

    assert_eq!(response.header("x-request-id"), Some("from-the-proxy"));
}
