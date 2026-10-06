//! Shared external account, pool and token links, read through the real HTTP router.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly on absent response fields"
)]

mod common;

use axum::http::StatusCode;
use common::TestApp;
use common::positions::{detail, listed_positions};
use serde_json::Value;

fn assert_wallet_links(wallet: &Value) {
    let address = wallet["address"].as_str().unwrap();
    assert_eq!(
        wallet["links"]["solscan"],
        format!("https://solscan.io/account/{address}")
    );
    assert_eq!(
        wallet["links"]["jupiter_portfolio"],
        format!("https://jup.ag/portfolio/{address}")
    );
}

fn assert_position_links(row: &Value) {
    let address = row["address"].as_str().unwrap();
    let pool = row["pool"]["address"].as_str().unwrap();
    let mint = row["pool"]["base"]["mint"].as_str().unwrap();
    assert_eq!(
        row["links"]["solscan"],
        format!("https://solscan.io/account/{address}")
    );
    assert_eq!(
        row["links"]["meteora"],
        format!("https://app.meteora.ag/dlmm/{pool}")
    );
    assert_eq!(
        row["links"]["gmgn"],
        format!("https://gmgn.ai/sol/token/{mint}")
    );
    assert_wallet_links(&row["wallet"]);
}

#[tokio::test]
async fn supplies_the_same_required_links_in_position_rows_and_details() {
    let app = TestApp::demo().await;
    let mut rows = listed_positions(&app).await;
    let history = app
        .get_signed_in("/api/v1/positions/closed?limit=200")
        .await;
    assert_eq!(history.status, StatusCode::OK);
    let history = history.json();
    rows.extend(history["items"].as_array().unwrap().iter().cloned());
    assert_ne!(rows.len(), 0);
    for row in rows {
        assert_position_links(&row);
        let position = detail(&app, row["id"].as_str().unwrap()).await;
        assert_position_links(&position);
        assert_eq!(position["links"], row["links"]);
    }
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn shares_wallet_links_across_wallets_and_both_overview_versions() {
    let app = TestApp::demo().await;
    let wallets = app.get_signed_in("/api/v1/wallets").await.json();
    for row in wallets["items"].as_array().unwrap() {
        let wallet = &row["wallet"];
        assert_wallet_links(wallet);
        let address = wallet["address"].as_str().unwrap();
        for version in [1, 2] {
            let response = app
                .get_signed_in(&format!("/api/v{version}/overview?wallet={address}"))
                .await;
            assert_eq!(response.status, StatusCode::OK);
            let overview = response.json();
            assert_wallet_links(&overview["wallet"]);
            assert_eq!(overview["wallet"]["links"], wallet["links"]);
        }
    }
    assert_eq!((app.network_io)(), (0, 0));
}
