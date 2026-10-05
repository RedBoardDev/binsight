//! An immutable generated world keeps its financial read instant across local midnight.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "HTTP tests assert the generated world"
)]

mod common;

use axum::http::StatusCode;
use binsight_core::clock::Clock;
use jiff::tz::TimeZone;

use common::{TEST_TIMEZONE, TestApp};

#[tokio::test]
async fn keeps_overview_series_and_simulated_credits_at_the_world_anchor_after_midnight() {
    let app = TestApp::demo().await;
    let anchor = app.clock.now();
    let paths = [
        "/api/v1/overview",
        "/api/v1/stats/series?series=real_pnl&period=today",
        "/api/v1/sync",
    ];
    let mut before = Vec::new();
    for path in paths {
        let response = app.get_signed_in(path).await;
        assert_eq!(response.status, StatusCode::OK);
        before.push(response.json());
    }
    app.advance_clock(86_400);
    let timezone = TimeZone::get(TEST_TIMEZONE).unwrap();
    assert_ne!(
        anchor.to_zoned(timezone.clone()).date(),
        app.clock.now().to_zoned(timezone).date()
    );
    for (path, expected) in paths.into_iter().zip(before) {
        let response = app.get_signed_in(path).await;
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            response.json(),
            expected,
            "{path} must use the unchanged world"
        );
    }
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn keeps_open_chart_and_fresh_candles_at_the_world_anchor_after_midnight() {
    let app = TestApp::demo().await;
    let open = app.get_signed_in("/api/v1/positions/open").await.json();
    let id = open["items"][0]["id"].as_str().unwrap();
    let drawer_path = format!("/api/v1/positions/{id}");
    let candles_path = format!("/api/v1/positions/{id}/candles");
    let drawer = app.get_signed_in(&drawer_path).await;
    assert_eq!(drawer.status, StatusCode::OK);
    let candles = app.get_signed_in(&candles_path).await;
    assert_eq!(candles.status, StatusCode::OK);
    assert_eq!(candles.header("cache-control"), Some("no-store"));
    assert_eq!(candles.json()["status"]["state"], "fresh");
    app.advance_clock(86_400);
    let later_drawer = app.get_signed_in(&drawer_path).await;
    assert_eq!(later_drawer.status, StatusCode::OK);
    assert_eq!(later_drawer.json(), drawer.json());
    let later_candles = app.get_signed_in(&candles_path).await;
    assert_eq!(later_candles.status, StatusCode::OK);
    assert_eq!(later_candles.header("cache-control"), Some("no-store"));
    assert_eq!(later_candles.json()["status"]["state"], "fresh");
    assert_eq!(later_candles.json(), candles.json());
    assert_eq!((app.network_io)(), (0, 0));
}
