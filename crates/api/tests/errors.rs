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

#[tokio::test]
async fn answers_a_body_that_is_not_json_with_invalid_request() {
    let app = TestApp::new().await;
    let request = Request::post("/api/v1/auth/login")
        .header("content-type", "application/json")
        .body(Body::from("{not json"))
        .unwrap();

    let response = app.send(request).await;

    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["error"]["code"], "invalid_request");
}

#[tokio::test]
async fn answers_a_body_without_a_json_content_type_with_invalid_request() {
    let app = TestApp::new().await;
    let request = Request::post("/api/v1/auth/login")
        .body(Body::from(r#"{"password":"x"}"#))
        .unwrap();

    let response = app.send(request).await;

    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["error"]["code"], "invalid_request");
}

#[tokio::test]
async fn answers_an_oversized_body_with_a_json_413() {
    let app = TestApp::new().await;
    let password = "x".repeat(70 * 1024);
    let request = Request::post("/api/v1/auth/login")
        .header("content-type", "application/json")
        .body(Body::from(format!(r#"{{"password":"{password}"}}"#)))
        .unwrap();

    let response = app.send(request).await;

    assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
    insta::assert_json_snapshot!(response.json(), { ".error.request_id" => "[request_id]" }, @r#"
    {
      "error": {
        "code": "payload_too_large",
        "message": "the request body is too large",
        "request_id": "[request_id]"
      }
    }
    "#);
}
