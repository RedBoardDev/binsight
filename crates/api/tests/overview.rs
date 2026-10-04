//! The overview routes on the demo world: their figures agree with each other, in SOL and in
//! dollars, for every wallet and for all of them.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly"
)]

mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::Value;

const CURRENCIES: [&str; 2] = ["sol", "usd"];
const PERIODS: [&str; 6] = ["today", "7d", "1m", "3m", "1y", "all"];

/// A canonical decimal string as an integer of `decimals` decimals.
fn units(text: &str, decimals: usize) -> i128 {
    let (negative, digits) = text
        .strip_prefix('-')
        .map_or((false, text), |rest| (true, rest));
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let padded = format!("{fraction:0<decimals$}");
    let value: i128 = format!("{whole}{padded}").parse().unwrap();
    if negative { -value } else { value }
}

/// The amount of a figure, in its unit's smallest units.
fn amount(figure: &Value) -> i128 {
    let decimals = if figure["value"]["unit"] == "sol" {
        9
    } else {
        6
    };
    units(figure["value"]["amount"].as_str().unwrap(), decimals)
}

/// Every scope query: all wallets, then each wallet.
async fn scopes(app: &TestApp) -> Vec<String> {
    let wallets = app.get_signed_in("/api/v1/wallets").await.json();
    let mut scopes = vec!["all".to_owned()];
    for item in wallets["items"].as_array().unwrap() {
        scopes.push(item["wallet"]["address"].as_str().unwrap().to_owned());
    }
    scopes
}

#[tokio::test]
async fn shows_the_same_today_in_the_overview_and_the_recent_closes() {
    let app = TestApp::demo().await;
    for scope in scopes(&app).await {
        for currency in CURRENCIES {
            let query = format!("wallet={scope}&currency={currency}");
            let overview = app
                .get_signed_in(&format!("/api/v1/overview?{query}"))
                .await
                .json();
            let recent = app
                .get_signed_in(&format!("/api/v1/positions/recent-closes?{query}"))
                .await
                .json();

            assert_eq!(
                overview["today"]["totals"], recent["days"][0]["totals"],
                "{query}"
            );
        }
    }
    let all = app.get_signed_in("/api/v1/overview").await.json();
    assert_eq!(all["today"]["totals"]["count"], 8);
}

#[tokio::test]
async fn adds_the_net_worth_parts_and_matches_the_open_positions() {
    let app = TestApp::demo().await;
    for scope in scopes(&app).await {
        for currency in CURRENCIES {
            let query = format!("wallet={scope}&currency={currency}");
            let overview = app
                .get_signed_in(&format!("/api/v1/overview?{query}"))
                .await
                .json();
            let open = app
                .get_signed_in(&format!("/api/v1/positions/open?{query}"))
                .await
                .json();
            let worth = &overview["net_worth"];
            let parts: i128 = ["idle", "lp", "unclaimed_fees", "recoverable_rent"]
                .iter()
                .map(|part| amount(&worth[part]))
                .sum();

            assert_eq!(amount(&worth["total"]), parts, "{query}");
            assert_eq!(open["totals"]["value"], worth["lp"], "{query}");
            assert_eq!(
                open["totals"]["unclaimed_fees"], worth["unclaimed_fees"],
                "{query}"
            );
            assert_eq!(
                overview["open"]["unclaimed_fees"], worth["unclaimed_fees"],
                "{query}"
            );
            assert_eq!(open["totals"]["pnl"], overview["open"]["pnl"], "{query}");
            let rows: i128 = open["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| amount(&row["value"]))
                .sum();
            assert_eq!(rows, amount(&open["totals"]["value"]), "{query}");
        }
    }
}

#[tokio::test]
async fn ends_the_real_pnl_series_on_the_gain_of_the_overview() {
    let app = TestApp::demo().await;
    for period in PERIODS {
        for currency in CURRENCIES {
            let query = format!("period={period}&currency={currency}");
            let overview = app
                .get_signed_in(&format!("/api/v1/overview?{query}"))
                .await
                .json();
            let series = app
                .get_signed_in(&format!("/api/v1/stats/series?series=real_pnl&{query}"))
                .await
                .json();
            let last = series["points"].as_array().unwrap().last().cloned();

            assert_eq!(
                series["header"]["value"], overview["gain"]["value"],
                "{query}"
            );
            if let Some(last) = last {
                assert_eq!(last["line"], overview["gain"]["value"], "{query}");
                assert_eq!(
                    last["line_share_of_net_worth"], overview["gain"]["pct"],
                    "{query}"
                );
            }
        }
    }
}

#[tokio::test]
async fn adds_the_closed_position_bars_up_to_the_series_total() {
    let app = TestApp::demo().await;
    for bucket in ["day", "week", "month"] {
        let path = format!("/api/v1/stats/series?series=positions&period=3m&bucket={bucket}");
        let series = app.get_signed_in(&path).await.json();
        let bars: i128 = series["points"]
            .as_array()
            .unwrap()
            .iter()
            .map(|point| amount(&point["bar"]))
            .sum();

        assert_eq!(bars, amount(&series["header"]["value"]), "{bucket}");
    }
}

#[tokio::test]
async fn reports_the_worst_sync_state_of_the_scope_as_its_freshness() {
    let app = TestApp::demo().await;
    let sync = app.get_signed_in("/api/v1/sync").await.json();

    let all = app.get_signed_in("/api/v1/overview").await.json();

    assert_eq!(all["freshness"]["state"], sync["state"]);
    assert_eq!(all["sync"]["state"], sync["state"]);
    for line in sync["wallets"].as_array().unwrap() {
        let address = line["wallet"]["address"].as_str().unwrap();
        let path = format!("/api/v1/overview?wallet={address}");
        let overview = app.get_signed_in(&path).await.json();

        assert_eq!(overview["freshness"]["state"], line["state"], "{address}");
    }
}

#[tokio::test]
async fn sorts_the_out_of_range_positions_first_and_draws_their_bins() {
    let app = TestApp::demo().await;

    let open = app.get_signed_in("/api/v1/positions/open").await.json();

    let items = open["items"].as_array().unwrap();
    assert_eq!(items.len(), 8);
    let statuses: Vec<&str> = items
        .iter()
        .map(|row| row["range"]["status"].as_str().unwrap())
        .collect();
    assert_ne!(statuses[0], "in_range");
    assert_ne!(statuses[1], "in_range");
    assert!(statuses[2..].iter().all(|status| *status == "in_range"));
    for row in items {
        let bars = row["bins"]["bars"].as_array().unwrap();
        assert!(!bars.is_empty() && bars.len() <= 70);
        let heights: Vec<i128> = bars
            .iter()
            .map(|bar| units(bar["height"].as_str().unwrap(), 6))
            .collect();
        assert!(
            heights
                .iter()
                .all(|height| (0..=1_000_000).contains(height))
        );
        assert!(heights.contains(&1_000_000));
    }
}

#[tokio::test]
async fn sorts_by_value_largest_first() {
    let app = TestApp::demo().await;

    let open = app
        .get_signed_in("/api/v1/positions/open?sort=value")
        .await
        .json();

    let values: Vec<i128> = open["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| amount(&row["value"]))
        .collect();
    assert!(
        values.windows(2).all(|pair| pair[0] >= pair[1]),
        "{values:?}"
    );
}

#[tokio::test]
async fn refuses_an_unknown_or_malformed_wallet() {
    let app = TestApp::demo().await;
    let untracked = "11111111111111111111111111111111";

    let unknown = app
        .get_signed_in(&format!("/api/v1/overview?wallet={untracked}"))
        .await;
    let malformed = app
        .get_signed_in("/api/v1/overview?wallet=not-an-address")
        .await;

    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    assert_eq!(unknown.json()["error"]["code"], "wallet_not_found");
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);
    assert_eq!(malformed.json()["error"]["code"], "invalid_request");
}

#[tokio::test]
async fn serves_the_logos_it_links_to_and_nothing_else() {
    let app = TestApp::demo().await;
    let open = app.get_signed_in("/api/v1/positions/open").await.json();
    let urls: Vec<String> = open["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| {
            row["pool"]["base"]["logo"]["url"]
                .as_str()
                .map(str::to_owned)
        })
        .collect();
    assert_ne!(urls.len(), 0);

    for url in urls {
        let logo = app.get_signed_in(&url).await;

        assert_eq!(logo.status, StatusCode::OK, "{url}");
        assert_eq!(logo.header("content-type"), Some("image/png"));
        assert_eq!(
            logo.header("cache-control"),
            Some("private, max-age=31536000, immutable")
        );
        assert!(logo.body.starts_with(b"\x89PNG"));
    }
    let missing = app
        .get_signed_in("/api/v1/tokens/11111111111111111111111111111111/logo")
        .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.json()["error"]["code"], "not_found");
}

#[tokio::test]
async fn reports_the_overview_of_every_wallet() {
    let app = TestApp::demo().await;

    let response = app.get_signed_in("/api/v1/overview?period=7d").await;

    assert_eq!(response.status, StatusCode::OK);
    insta::assert_json_snapshot!("demo_overview_7d", response.json());
}

#[tokio::test]
async fn answers_data_not_ready_while_the_engine_serves_nothing() {
    let app = TestApp::new().await;
    let routes = [
        "/api/v1/overview",
        "/api/v1/positions/open",
        "/api/v1/positions/recent-closes",
        "/api/v1/stats/series",
        "/api/v1/tokens/11111111111111111111111111111111/logo",
    ];
    for route in routes {
        let response = app.get_signed_in(route).await;

        assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE, "{route}");
        assert_eq!(
            response.json()["error"]["code"],
            "data_not_ready",
            "{route}"
        );
    }
}
