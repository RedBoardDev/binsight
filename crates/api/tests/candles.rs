//! The candles of the position charts on the demo world: they hold every marker, are cached once
//! the position is closed, and only come in the sizes the chart offers.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly"
)]

mod common;

use axum::http::StatusCode;
use common::TestApp;
use common::figures::units;
use common::positions::detail;
use serde_json::Value;

/// The decimals unit prices are compared with.
const PRICE_DECIMALS: usize = 18;

#[tokio::test]
async fn draws_candles_that_hold_every_marker_of_an_open_position() {
    let app = TestApp::demo().await;
    let open = app.get_signed_in("/api/v1/positions/open").await.json();

    for row in open["items"].as_array().unwrap() {
        let id = row["id"].as_str().unwrap();
        let chart = detail(&app, id).await["chart"].clone();
        let response = app
            .get_signed_in(&format!("/api/v1/positions/{id}/candles"))
            .await;
        assert_eq!(response.header("cache-control"), Some("no-store"));
        let candles = response.json();

        assert_eq!(candles["interval"], chart["default_interval"]);
        assert_eq!(candles["status"]["state"], "fresh");
        let candles = candles["candles"].as_array().unwrap();
        let price = |value: &Value| units(value.as_str().unwrap(), PRICE_DECIMALS);
        let holds = |candle: &Value, value: &Value| {
            price(&candle["low"]) <= price(value) && price(value) <= price(&candle["high"])
        };
        for marker in chart["markers"].as_array().unwrap() {
            let at = marker["at"].as_str().unwrap();
            let candle = candles
                .iter()
                .rev()
                .find(|candle| candle["start"].as_str().unwrap() <= at)
                .unwrap();
            assert!(holds(candle, &marker["price"]["amount"]), "{id} {at}");
        }
        let last = candles.last().unwrap();
        assert!(holds(last, &chart["current_price"]["amount"]), "{id}");
    }
}

#[tokio::test]
async fn caches_the_candles_of_a_closed_position_and_refuses_an_unfitting_size() {
    let app = TestApp::demo().await;
    let recent = app
        .get_signed_in("/api/v1/positions/recent-closes")
        .await
        .json();
    let id = recent["days"][1]["items"][0]["id"].as_str().unwrap();
    let chart = detail(&app, id).await["chart"].clone();
    let sizes = ["1m", "5m", "15m", "1h", "4h", "1d"];
    let unfitting = sizes
        .iter()
        .find(|size| {
            !chart["intervals"]
                .as_array()
                .unwrap()
                .contains(&Value::from(**size))
        })
        .unwrap();

    let candles = app
        .get_signed_in(&format!("/api/v1/positions/{id}/candles?interval=1d"))
        .await;
    let refused = app
        .get_signed_in(&format!(
            "/api/v1/positions/{id}/candles?interval={unfitting}"
        ))
        .await;

    assert_eq!(candles.status, StatusCode::OK);
    assert_eq!(
        candles.header("cache-control"),
        Some("private, max-age=86400")
    );
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert_eq!(refused.json()["error"]["code"], "invalid_request");
}
