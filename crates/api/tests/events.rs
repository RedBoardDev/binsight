//! The live event stream: who may listen, what comes first, the heartbeat and the end.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod common;

use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::TestApp;
use http_body_util::BodyExt;
use tower::ServiceExt;

/// Opens the stream with a session and returns the response.
async fn open_stream(app: &TestApp) -> axum::response::Response {
    let cookie = app.session_cookie().await;
    let request = Request::get("/api/v1/events")
        .header("cookie", cookie)
        .header("accept-encoding", "gzip, br")
        .body(Body::empty())
        .unwrap();
    app.router.clone().oneshot(request).await.unwrap()
}

/// Reads the next SSE message of `body` as text, or `None` once the stream has ended.
async fn next_message(body: &mut Body) -> Option<String> {
    let frame = body.frame().await?.unwrap();
    Some(String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap())
}

#[tokio::test]
async fn refuses_a_client_without_a_session() {
    let app = TestApp::new().await;

    let response = app.get("/api/v1/events").await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.json()["error"]["code"], "unauthenticated");
}

#[tokio::test]
async fn streams_uncompressed_server_sent_events() {
    let app = TestApp::new().await;

    let response = open_stream(&app).await;

    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers();
    assert_eq!(headers["content-type"], "text/event-stream");
    assert_eq!(headers.get("content-encoding"), None);
    assert_eq!(headers["x-accel-buffering"], "no");
}

#[tokio::test]
async fn sends_the_engine_status_as_soon_as_a_client_connects() {
    let app = TestApp::new().await;

    let mut body = open_stream(&app).await.into_body();

    let first = next_message(&mut body).await.unwrap();
    assert_eq!(
        first,
        "event: engine_status\ndata: {\"type\":\"engine_status\",\"status\":\"starting\"}\nretry: 5000\n\n"
    );
}

#[tokio::test]
async fn sends_a_heartbeat_every_fifteen_seconds() {
    let app = TestApp::new().await;
    let mut body = open_stream(&app).await.into_body();
    next_message(&mut body).await.unwrap();
    tokio::time::pause();

    tokio::time::advance(Duration::from_secs(15)).await;
    let heartbeat = next_message(&mut body).await.unwrap();

    assert_eq!(
        heartbeat,
        "event: heartbeat\ndata: {\"type\":\"heartbeat\",\"server_time\":\"2026-09-21T14:13:20Z\"}\n\n"
    );
}

#[tokio::test]
async fn relays_the_status_changes_of_the_engine() {
    let mut app = TestApp::new().await;
    let mut body = open_stream(&app).await.into_body();
    next_message(&mut body).await.unwrap();

    let engine = app.start_engine();
    let change = next_message(&mut body).await.unwrap();

    assert!(change.contains("\"status\":\"running\""), "{change}");
    app.shutdown.cancel();
    engine.await.unwrap();
}

#[tokio::test]
async fn ends_the_stream_when_its_session_expires() {
    let app = TestApp::new().await;
    let cookie = app.session_cookie().await;
    app.advance_clock(30 * 86_400 - 10);
    let request = Request::get("/api/v1/events")
        .header("cookie", cookie)
        .body(Body::empty())
        .unwrap();
    let mut body = app
        .router
        .clone()
        .oneshot(request)
        .await
        .unwrap()
        .into_body();
    next_message(&mut body).await.unwrap();
    tokio::time::pause();

    tokio::time::advance(Duration::from_secs(10)).await;
    let after_expiry = next_message(&mut body).await;

    assert_eq!(after_expiry, None);
}

#[tokio::test]
async fn ends_the_stream_when_the_server_shuts_down() {
    let app = TestApp::new().await;
    let mut body = open_stream(&app).await.into_body();
    next_message(&mut body).await.unwrap();

    app.shutdown.cancel();
    let after_shutdown = tokio::time::timeout(Duration::from_secs(1), next_message(&mut body))
        .await
        .unwrap();

    assert_eq!(after_shutdown, None);
}
