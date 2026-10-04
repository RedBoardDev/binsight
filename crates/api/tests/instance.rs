//! The instance routes: synchronization, settings and wallets, on the demo world and in chain
//! mode.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod common;

use axum::http::StatusCode;
use common::TestApp;

const ROUTES: [&str; 3] = ["/api/v1/sync", "/api/v1/settings", "/api/v1/wallets"];

#[tokio::test]
async fn answers_data_not_ready_while_the_engine_serves_nothing() {
    let app = TestApp::new().await;

    for route in ROUTES {
        let response = app.get_signed_in(route).await;

        assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE, "{route}");
        assert_eq!(
            response.json()["error"]["code"],
            "data_not_ready",
            "{route}"
        );
    }
}

#[tokio::test]
async fn requires_a_session() {
    let app = TestApp::demo().await;

    for route in ROUTES {
        let response = app.get(route).await;

        assert_eq!(response.status, StatusCode::UNAUTHORIZED, "{route}");
    }
}

#[tokio::test]
async fn reports_the_sync_of_the_demo_instance() {
    let app = TestApp::demo().await;

    let response = app.get_signed_in("/api/v1/sync").await;

    assert_eq!(response.status, StatusCode::OK);
    insta::assert_json_snapshot!("demo_sync_report", response.json());
}

#[tokio::test]
async fn reports_the_settings_of_the_demo_instance() {
    let app = TestApp::demo().await;

    let response = app.get_signed_in("/api/v1/settings").await;

    insta::assert_json_snapshot!(response.json(), @r#"
    {
      "default_currency": "sol",
      "hide_amounts_by_default": false,
      "timezone": "Europe/Paris",
      "timezone_source": "default"
    }
    "#);
}

#[tokio::test]
async fn lists_the_demo_wallets_in_sol_and_in_dollars() {
    let app = TestApp::demo().await;

    let in_sol = app.get_signed_in("/api/v1/wallets").await;
    let in_usd = app.get_signed_in("/api/v1/wallets?currency=usd").await;

    insta::assert_json_snapshot!("demo_wallets_in_sol", in_sol.json());
    assert_eq!(in_usd.status, StatusCode::OK);
    assert_eq!(in_usd.json()["total"]["net_worth"]["value"]["unit"], "usd");
}

#[tokio::test]
async fn refuses_an_unknown_currency() {
    let app = TestApp::demo().await;

    let response = app.get_signed_in("/api/v1/wallets?currency=eur").await;

    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["error"]["code"], "invalid_request");
}

#[tokio::test]
async fn shows_each_wallet_with_the_same_sync_as_the_sync_report() {
    let app = TestApp::demo().await;

    let sync = app.get_signed_in("/api/v1/sync").await.json();
    let wallets = app.get_signed_in("/api/v1/wallets").await.json();

    let states: Vec<&str> = sync["wallets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|line| line["state"].as_str().unwrap())
        .collect();
    let listed: Vec<&str> = wallets["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["sync"]["state"].as_str().unwrap())
        .collect();
    assert_eq!(states, listed);
    assert_eq!(sync["state"], "lagging");
}
