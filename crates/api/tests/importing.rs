//! Incomplete synthetic imports preserve known rows and explain unavailable period totals.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly"
)]

mod common;

use binsight_core::ratio::Percent;
use binsight_demo::ImportingWalletSpec;
use jiff::{SignedDuration, Timestamp};
use serde_json::Value;

use common::figures::scopes;
use common::{Figures, START_SECONDS, TestApp, TestAppOptions};

async fn importing(indexed_since: Option<Timestamp>) -> TestApp {
    TestApp::with(TestAppOptions {
        figures: Figures::Demo,
        importing_wallet: Some(ImportingWalletSpec {
            wallet_index: 0,
            indexed_since,
            progress: Percent(40_000_000),
        }),
        ..TestAppOptions::default()
    })
    .await
}

fn assert_incomplete(figure: &Value, wallet: &str) {
    assert_eq!(figure["exactness"], "unavailable", "{figure}");
    assert!(figure.get("value").is_none(), "{figure}");
    assert!(
        figure["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| { reason["code"] == "history_incomplete" && reason["wallet"] == wallet }),
        "{figure}"
    );
}

#[tokio::test]
async fn leaves_known_rows_exact_but_uncovered_days_unavailable() {
    let now = Timestamp::from_second(START_SECONDS).unwrap();
    let app = importing(Some(
        now.checked_sub(SignedDuration::from_hours(3)).unwrap(),
    ))
    .await;
    let scopes = scopes(&app).await;
    let wallet = &scopes[1];
    let baseline = TestApp::demo().await;
    for currency in ["sol", "usd"] {
        for scope in ["all", wallet.as_str()] {
            let query = format!("wallet={scope}&currency={currency}");
            let overview = app
                .get_signed_in(&format!("/api/v1/overview?{query}"))
                .await
                .json();
            let recent = app
                .get_signed_in(&format!("/api/v1/positions/recent-closes?{query}"))
                .await
                .json();
            assert_incomplete(&overview["today"]["totals"]["pnl"], wallet);
            assert_eq!(overview["today"]["totals"], recent["days"][0]["totals"]);
            assert_eq!(overview["open"]["pnl"]["exactness"], "estimated");
            assert_incomplete(&overview["gain"]["value"], wallet);
        }
        let path =
            format!("/api/v1/positions/closed?wallet={wallet}&currency={currency}&limit=200");
        let page = app.get_signed_in(&path).await.json();
        let full = baseline.get_signed_in(&path).await.json();
        let known = page["items"].as_array().unwrap();
        let empty: &[Value] = &[];
        assert_ne!(known.as_slice(), empty);
        for row in known {
            let original = full["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|original| original["id"] == row["id"])
                .unwrap();
            assert_eq!(row, original);
        }
        for group in page["day_groups"].as_array().unwrap() {
            assert_incomplete(&group["pnl"], wallet);
        }
        let other = app
            .get_signed_in(&format!(
                "/api/v1/overview?wallet={}&currency={currency}",
                scopes[2]
            ))
            .await
            .json();
        assert_ne!(other["today"]["totals"]["pnl"]["exactness"], "unavailable");
    }
}

#[tokio::test]
async fn computes_covered_today_but_keeps_older_positions_series_unavailable() {
    let now = Timestamp::from_second(START_SECONDS).unwrap();
    let app = importing(Some(
        now.checked_sub(SignedDuration::from_hours(36)).unwrap(),
    ))
    .await;
    let wallet = scopes(&app).await[1].clone();
    for currency in ["sol", "usd"] {
        let overview = app
            .get_signed_in(&format!(
                "/api/v1/overview?wallet={wallet}&currency={currency}"
            ))
            .await
            .json();
        let pnl = &overview["today"]["totals"]["pnl"];
        if currency == "usd" {
            assert_eq!(pnl["exactness"], "estimated");
            assert_eq!(pnl["reasons"][0]["code"], "provisional_rate");
        } else {
            assert_eq!(pnl["exactness"], "complete");
        }
        let today = app.get_signed_in(&format!("/api/v1/stats/series?series=positions&period=today&wallet={wallet}&currency={currency}")).await.json();
        assert_eq!(today["header"]["value"], overview["today"]["totals"]["pnl"]);
        let week = app.get_signed_in(&format!("/api/v1/stats/series?series=positions&period=7d&wallet={wallet}&currency={currency}")).await.json();
        assert_incomplete(&week["header"]["value"], &wallet);
        assert_incomplete(&week["points"][0]["bar"], &wallet);
        assert_incomplete(&week["points"][0]["line"], &wallet);
    }
}

#[tokio::test]
async fn never_calls_an_unindexed_empty_history_complete() {
    let app = importing(None).await;
    let wallet = scopes(&app).await[1].clone();
    let overview = app
        .get_signed_in(&format!("/api/v1/overview?wallet={wallet}"))
        .await
        .json();
    assert_eq!(overview["today"]["totals"]["count"], 0);
    assert_incomplete(&overview["today"]["totals"]["pnl"], &wallet);
    assert_eq!(overview["open"]["pnl"]["exactness"], "estimated");
    let sync = app.get_signed_in("/api/v1/sync").await.json();
    assert_eq!(sync["wallets"][0]["state"], "importing");
    assert_eq!(sync["wallets"][0]["import"]["progress"], "40");
}
