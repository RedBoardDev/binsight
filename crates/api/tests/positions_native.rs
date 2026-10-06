//! Native position PnL travels independently of display currency through the real HTTP router.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly on absent response fields"
)]

mod common;
#[path = "positions_native/source.rs"]
mod source;

use axum::http::StatusCode;
use common::{TestApp, TestAppOptions};
use serde_json::{Value, json};
use source::{NativePositions, id};
use std::sync::Arc;

async fn app() -> (TestApp, Arc<NativePositions>) {
    let source = Arc::new(NativePositions::new());
    let app = TestApp::with(TestAppOptions {
        read_model: Some(source.clone()),
        ..TestAppOptions::default()
    })
    .await;
    (app, source)
}

async fn read(app: &TestApp, byte: u8, currency: &str) -> Value {
    let response = app
        .get_signed_in(&format!(
            "/api/v1/positions/{}?currency={currency}",
            id(byte)
        ))
        .await;
    assert_eq!(response.status, StatusCode::OK);
    response.json()
}

#[tokio::test]
async fn keeps_stable_native_pnl_complete_in_both_orientations_without_fx() {
    let (app, source) = app().await;
    let expected = json!({"exactness":"complete", "value":{"amount":"520", "unit":"usdc"}});
    for byte in [1, 2] {
        let sol = read(&app, byte, "sol").await;
        let usd = read(&app, byte, "usd").await;
        assert_eq!(sol["native_pnl"], expected);
        assert_eq!(usd["native_pnl"], expected);
        assert_eq!(sol["pnl"]["exactness"], "unavailable");
        assert!(
            sol["pnl"]["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|reason| reason["code"] == "no_usd_rate")
        );
        assert!(sol["pnl"].get("value").is_none());
        assert_eq!(usd["pnl"]["value"]["amount"], "520");
        assert_eq!(usd["pnl"]["value"]["unit"], "usd");
        assert_eq!(sol["id"], usd["id"]);
        assert_eq!(sol["chart"], usd["chart"]);
    }
    assert_eq!(source.reads(), 4);
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn follows_the_closed_pnl_method_instead_of_relabeling_lp_pnl() {
    let (app, source) = app().await;
    for (byte, amount, method) in [(10, "10", "pool"), (11, "-7", "fifo")] {
        let sol = read(&app, byte, "sol").await;
        let usd = read(&app, byte, "usd").await;
        assert_eq!(sol["native_pnl"], usd["native_pnl"]);
        assert_eq!(
            usd["native_pnl"],
            json!({"exactness":"complete", "value":{"amount":amount, "unit":"usdc"}})
        );
        assert_eq!(usd["method"], method);
        assert_eq!(usd["pnl"]["value"]["amount"], amount);
        assert_eq!(usd["lp_pnl"]["value"]["amount"], "10");
        assert_eq!(sol["pnl"]["exactness"], "unavailable");
    }
    assert_eq!(source.reads(), 4);
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn keeps_sol_native_known_when_the_dollar_conversion_is_missing() {
    let (app, source) = app().await;
    let sol = read(&app, 8, "sol").await;
    let usd = read(&app, 8, "usd").await;
    assert_eq!(sol["native_pnl"], usd["native_pnl"]);
    assert_eq!(
        sol["native_pnl"],
        json!({"exactness":"complete", "value":{"amount":"0.52", "unit":"sol"}})
    );
    assert_eq!(usd["pnl"]["exactness"], "unavailable");
    assert_eq!(source.reads(), 2);
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn requires_unavailable_native_pnl_for_unsupported_open_and_closed_pools() {
    let (app, source) = app().await;
    for byte in [7, 12] {
        for currency in ["sol", "usd"] {
            let position = read(&app, byte, currency).await;
            let native = position.get("native_pnl").unwrap();
            assert_eq!(native["exactness"], "unavailable");
            assert!(native.get("value").is_none());
            assert!(
                native["reasons"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|reason| reason["code"] == "unsupported_quote")
            );
        }
    }
    assert_eq!(source.reads(), 4);
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn reads_each_detail_once_and_refuses_auth_and_invalid_requests_before_reading() {
    let (app, source) = app().await;
    let path = format!("/api/v1/positions/{}", id(1));
    assert_eq!(app.get(&path).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        app.get_signed_in("/api/v1/positions/not-an-id")
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.get_signed_in(&format!("{path}?currency=usdc"))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(source.reads(), 0);
    let known = app.get_signed_in(&path).await;
    assert_eq!(known.status, StatusCode::OK);
    assert_eq!(source.reads(), 1);
    let unknown = app
        .get_signed_in(&format!("/api/v1/positions/{}", id(99)))
        .await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    assert_eq!(unknown.json()["error"]["code"], "position_not_found");
    assert_eq!(source.reads(), 2);
    assert_eq!((app.network_io)(), (0, 0));
}
