//! The web app is served for every path that is not an API route.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{INDEX_HTML, TestApp};

/// The `ETag` of the fake `index.html` (its hash is 32 bytes of 1).
const INDEX_ETAG: &str = "\"0101010101010101010101010101010101010101010101010101010101010101\"";

#[tokio::test]
async fn serves_the_index_page_at_the_root() {
    let app = TestApp::new().await;

    let response = app.get("/").await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body, INDEX_HTML.as_bytes());
    assert_eq!(response.header("content-type"), Some("text/html"));
    assert_eq!(response.header("cache-control"), Some("no-cache"));
    assert_eq!(response.header("etag"), Some(INDEX_ETAG));
    assert_eq!(response.header("x-frame-options"), Some("DENY"));
}

#[tokio::test]
async fn serves_the_index_page_for_the_routes_of_the_app() {
    let app = TestApp::new().await;

    let response = app.get("/positions/abc").await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body, INDEX_HTML.as_bytes());
}

#[tokio::test]
async fn caches_content_hashed_files_for_a_year() {
    let app = TestApp::new().await;

    let response = app.get("/assets/app-1a2b.js").await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.header("content-type"), Some("text/javascript"));
    assert_eq!(
        response.header("cache-control"),
        Some("public, max-age=31536000, immutable")
    );
}

#[tokio::test]
async fn revalidates_the_manifest_on_each_use() {
    let app = TestApp::new().await;

    let response = app.get("/manifest.webmanifest").await;

    assert_eq!(
        response.header("content-type"),
        Some("application/manifest+json")
    );
    assert_eq!(response.header("cache-control"), Some("no-cache"));
}

#[tokio::test]
async fn answers_a_missing_file_with_404_rather_than_the_index_page() {
    let app = TestApp::new().await;

    for path in ["/missing.js", "/assets/nope.js", "/../index.html"] {
        let response = app.get(path).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn never_answers_an_unknown_api_path_with_the_web_app() {
    let app = TestApp::new().await;

    for path in ["/api", "/api/v1/nope", "/api/positions"] {
        let response = app.get(path).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(response.json()["error"]["code"], "not_found", "{path}");
    }
}

#[tokio::test]
async fn answers_304_when_the_client_copy_is_current() {
    let app = TestApp::new().await;
    let request = Request::get("/")
        .header("if-none-match", INDEX_ETAG)
        .body(Body::empty())
        .unwrap();

    let response = app.send(request).await;

    assert_eq!(response.status, StatusCode::NOT_MODIFIED);
    assert!(response.body.is_empty());
    assert_eq!(response.header("etag"), Some(INDEX_ETAG));
}

#[tokio::test]
async fn answers_head_without_a_body() {
    let app = TestApp::new().await;
    let request = Request::head("/").body(Body::empty()).unwrap();

    let response = app.send(request).await;

    assert_eq!(response.status, StatusCode::OK);
    assert!(response.body.is_empty());
    assert_eq!(response.header("content-type"), Some("text/html"));
}

#[tokio::test]
async fn refuses_to_post_to_a_page_of_the_app() {
    let app = TestApp::new().await;
    let request = Request::post("/positions").body(Body::empty()).unwrap();

    let response = app.send(request).await;

    assert_eq!(response.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(response.json()["error"]["code"], "method_not_allowed");
}
