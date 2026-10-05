//! Browser caches must not freeze a candle-source outage for a closed position.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "HTTP tests assert generated responses"
)]

mod common;

use axum::http::StatusCode;
use binsight_core::clock::Clock;
use common::TestApp;

#[tokio::test]
async fn leaves_unavailable_closed_candles_retryable() {
    let app = TestApp::demo().await;
    let cookie = app.session_cookie().await;
    let page = app
        .get_with_cookie("/api/v1/positions/closed?limit=200&order=asc", &cookie)
        .await;
    assert_eq!(page.status, StatusCode::OK);
    let mut found_fresh = false;
    let mut found_unavailable = false;
    for row in page.json()["items"].as_array().unwrap() {
        let id = row["id"].as_str().unwrap();
        let response = app
            .get_with_cookie(&format!("/api/v1/positions/{id}/candles"), &cookie)
            .await;
        assert_eq!(response.status, StatusCode::OK);
        let window_end: jiff::Timestamp = response.json()["to"].as_str().unwrap().parse().unwrap();
        assert!(window_end < app.clock.now(), "the window must be finished");
        match response.json()["status"]["state"].as_str().unwrap() {
            "fresh" => {
                found_fresh = true;
                assert_eq!(
                    response.header("cache-control"),
                    Some("private, max-age=86400")
                );
            }
            "unavailable" => {
                found_unavailable = true;
                assert_eq!(response.header("cache-control"), Some("no-store"));
            }
            state => panic!("unexpected generated candle status {state}"),
        }
        if found_fresh && found_unavailable {
            break;
        }
    }
    assert!(
        found_fresh && found_unavailable,
        "the fixture must exercise both source outcomes"
    );
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn does_not_store_fresh_live_candles() {
    let app = TestApp::demo().await;
    let open = app.get_signed_in("/api/v1/positions/open").await.json();
    let id = open["items"][0]["id"].as_str().unwrap();
    let response = app
        .get_signed_in(&format!("/api/v1/positions/{id}/candles"))
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(response.json()["status"]["state"], "fresh");
}
