//! Every failure answers with the same JSON error body.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::TestApp;

#[tokio::test]
async fn answers_an_unknown_api_route_with_a_json_404() {
    let app = TestApp::new().await;

    let response = app.get("/api/v1/nope").await;

    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.header("content-type"), Some("application/json"));
    let request_id = response.header("x-request-id").unwrap().to_owned();
    let body = response.json();
    assert_eq!(body["error"]["request_id"], request_id.as_str());
    insta::assert_json_snapshot!(body, { ".error.request_id" => "[request_id]" }, @r#"
    {
      "error": {
        "code": "not_found",
        "message": "there is no route at /api/v1/nope",
        "request_id": "[request_id]"
      }
    }
    "#);
}

#[tokio::test]
async fn answers_a_wrong_method_with_a_json_405() {
    let app = TestApp::new().await;
    let request = Request::delete("/api/v1/health")
        .body(Body::empty())
        .unwrap();

    let response = app.send(request).await;

    assert_eq!(response.status, StatusCode::METHOD_NOT_ALLOWED);
    insta::assert_json_snapshot!(response.json(), { ".error.request_id" => "[request_id]" }, @r#"
    {
      "error": {
        "code": "method_not_allowed",
        "message": "this route does not accept this HTTP method",
        "request_id": "[request_id]"
      }
    }
    "#);
}

#[tokio::test]
async fn answers_an_unknown_api_version_with_a_json_404() {
    let app = TestApp::new().await;

    let response = app.get("/api/v9/health").await;

    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.json()["error"]["code"], "not_found");
}
