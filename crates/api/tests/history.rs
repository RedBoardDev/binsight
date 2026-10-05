//! History on the demo world: its pages add up to its counts and day summaries whatever the
//! filter and sort, its filters keep only what they name, and its pools match its lists.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly"
)]

mod common;

use std::collections::{BTreeMap, BTreeSet};

use axum::http::StatusCode;
use common::TestApp;
use common::figures::amount;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde_json::Value;

/// Every page of `query`, read `limit` at a time, and the first page.
async fn all_pages(app: &TestApp, query: &str, limit: usize) -> (Vec<Value>, Value) {
    let cookie = app.session_cookie().await;
    let mut rows = Vec::new();
    let mut cursor: Option<String> = None;
    let mut first: Option<Value> = None;
    loop {
        let after = cursor.map_or(String::new(), |cursor| format!("&cursor={cursor}"));
        let path = format!("/api/v1/positions/closed?{query}&limit={limit}{after}");
        let response = app.get_with_cookie(&path, &cookie).await;
        assert_eq!(response.status, StatusCode::OK, "{path}");
        let page = response.json();
        rows.extend(page["items"].as_array().unwrap().iter().cloned());
        let next = page["next_cursor"].as_str().map(str::to_owned);
        first.get_or_insert(page);
        match next {
            Some(next) => cursor = Some(next),
            None => return (rows, first.unwrap()),
        }
    }
}

/// The local date of an instant in the test instance's time zone.
fn local_day(instant: &Value) -> String {
    let instant: Timestamp = instant.as_str().unwrap().parse().unwrap();
    let zone = TimeZone::get(common::TEST_TIMEZONE).unwrap();
    instant.to_zoned(zone).date().to_string()
}

fn ids(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn pages_every_filter_and_sort_without_overlap_gap_or_drift() {
    let app = TestApp::demo().await;
    let queries = [
        "sort=closed_at",
        "sort=closed_at&order=asc&outcome=win,loss",
        "sort=pnl&currency=usd",
        "sort=pnl_pct&order=asc&strategy=spot,curve",
        "sort=held&outcome=flat",
        "sort=invested&search=sol",
        "sort=dpr&currency=usd&outcome=loss",
    ];
    for query in queries {
        let (whole, first) = all_pages(&app, query, 200).await;
        let (paged, _) = all_pages(&app, query, 7).await;

        assert_eq!(ids(&paged), ids(&whole), "{query}");
        let unique: BTreeSet<String> = ids(&whole).into_iter().collect();
        assert_eq!(unique.len(), whole.len(), "{query}");
        assert_eq!(first["matched_count"], whole.len(), "{query}");
    }
}

#[tokio::test]
async fn sorts_amounts_on_the_server_largest_first() {
    let app = TestApp::demo().await;

    let (rows, _) = all_pages(&app, "sort=pnl", 200).await;

    let pnl: Vec<i128> = rows.iter().map(|row| amount(&row["pnl"])).collect();
    assert!(pnl.windows(2).all(|pair| pair[0] >= pair[1]));
}

#[tokio::test]
async fn sums_each_day_over_the_whole_filtered_list() {
    let app = TestApp::demo().await;
    let query = "sort=closed_at&strategy=bid_ask";
    let (rows, _) = all_pages(&app, query, 200).await;
    let mut expected: BTreeMap<String, (usize, i128)> = BTreeMap::new();
    for row in &rows {
        let entry = expected.entry(local_day(&row["closed_at"])).or_default();
        entry.0 += 1;
        entry.1 += amount(&row["pnl"]);
    }

    let page = app
        .get_signed_in(&format!("/api/v1/positions/closed?{query}&limit=20"))
        .await
        .json();

    let groups = page["day_groups"].as_array().unwrap();
    assert_ne!(groups, &Vec::<Value>::new());
    for group in groups {
        let day = group["day"].as_str().unwrap();
        let (count, pnl) = expected[day];
        assert_eq!(group["count"], count, "{day}");
        assert_eq!(amount(&group["pnl"]), pnl, "{day}");
    }
}

#[tokio::test]
async fn shows_today_as_the_overview_does_with_or_without_flat_positions() {
    let app = TestApp::demo().await;
    let overview = app.get_signed_in("/api/v1/overview").await.json();
    let totals = &overview["today"]["totals"];
    let today = local_day(&overview["today"]["window"]["start"]);

    let every = app
        .get_signed_in("/api/v1/positions/closed?limit=1")
        .await
        .json();
    let shown = app
        .get_signed_in("/api/v1/positions/closed?limit=1&outcome=win,loss")
        .await
        .json();

    let (every, shown) = (&every["day_groups"][0], &shown["day_groups"][0]);
    assert_eq!(
        (&every["day"], &shown["day"]),
        (&today.clone().into(), &today.into())
    );
    for field in [
        "count",
        "wins",
        "losses",
        "flat",
        "unclassified_count",
        "win_rate",
        "pnl",
    ] {
        assert_eq!(every[field], totals[field], "{field}");
    }
    for field in ["wins", "losses", "win_rate", "pnl"] {
        assert_eq!(shown[field], totals[field], "{field}");
    }
    assert_eq!(shown["flat"], 0);
    assert_eq!(
        shown["count"].as_u64().unwrap()
            + totals["flat"].as_u64().unwrap()
            + totals["unclassified_count"].as_u64().unwrap(),
        totals["count"].as_u64().unwrap()
    );
}

#[tokio::test]
async fn keeps_only_what_the_filters_name() {
    let app = TestApp::demo().await;

    let (flat, _) = all_pages(&app, "outcome=flat", 200).await;
    let (clear, _) = all_pages(&app, "outcome=win,loss", 200).await;
    let (spot, _) = all_pages(&app, "strategy=spot", 200).await;
    let (all, _) = all_pages(&app, "", 200).await;

    assert_ne!(flat, Vec::<Value>::new());
    assert!(
        flat.iter()
            .all(|row| row["outcome"] == "flat" && amount(&row["pnl"]) == 0)
    );
    assert!(
        clear
            .iter()
            .all(|row| row["outcome"] == "win" || row["outcome"] == "loss")
    );
    assert!(flat.iter().any(|row| row["is_shell"] == true));
    let unclassified = all.iter().filter(|row| row["outcome"].is_null()).count();
    assert!(unclassified > 0);
    assert_eq!(flat.len() + clear.len() + unclassified, all.len());
    assert!(spot.iter().all(|row| row["strategy"] == "spot"));
}

#[tokio::test]
async fn counts_closes_alike_in_the_wallets_and_history() {
    let app = TestApp::demo().await;
    let wallets = app.get_signed_in("/api/v1/wallets").await.json();
    let history = app
        .get_signed_in("/api/v1/positions/closed?limit=1")
        .await
        .json();

    let per_wallet: u64 = wallets["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["closed_count"].as_u64().unwrap())
        .sum();

    assert_eq!(
        per_wallet,
        wallets["total"]["closed_count"].as_u64().unwrap()
    );
    assert_eq!(history["total_count"].as_u64().unwrap(), per_wallet);
    assert_eq!(history["matched_count"], history["total_count"]);
}

#[tokio::test]
async fn lists_each_pool_with_as_many_closes_as_history_shows_for_it() {
    let app = TestApp::demo().await;
    let pools = app.get_signed_in("/api/v1/pools?limit=50").await.json();
    let pools = pools["items"].as_array().unwrap();
    let (rows, first) = all_pages(&app, "", 200).await;

    let listed: BTreeSet<&str> = pools
        .iter()
        .map(|option| option["pool"]["address"].as_str().unwrap())
        .collect();
    assert!(
        rows.iter()
            .all(|row| listed.contains(row["pool"]["address"].as_str().unwrap()))
    );
    for option in pools {
        let address = option["pool"]["address"].as_str().unwrap();
        let page = app
            .get_signed_in(&format!("/api/v1/positions/closed?pool={address}&limit=1"))
            .await
            .json();
        assert_eq!(page["matched_count"], option["closed_count"], "{address}");
    }
    assert_eq!(first["total_count"], rows.len());
}

#[tokio::test]
async fn finds_pools_by_symbol_with_exact_matches_first() {
    let app = TestApp::demo().await;

    let found = app.get_signed_in("/api/v1/pools?search=bonk").await.json();

    let items = found["items"].as_array().unwrap();
    let steps: BTreeSet<u64> = items
        .iter()
        .filter(|option| option["pool"]["base"]["symbol"] == "BONK")
        .map(|option| option["pool"]["bin_step"].as_u64().unwrap())
        .collect();
    assert_eq!(items[0]["pool"]["base"]["symbol"], "BONK");
    assert!(steps.len() >= 2, "{steps:?}");
}

#[tokio::test]
async fn refuses_a_cursor_of_another_query_and_bad_parameters() {
    let app = TestApp::demo().await;
    let page = app
        .get_signed_in("/api/v1/positions/closed?limit=2")
        .await
        .json();
    let cursor = page["next_cursor"].as_str().unwrap();
    let pools = (0..21)
        .map(|_| "11111111111111111111111111111111")
        .collect::<Vec<_>>()
        .join(",");

    let foreign = app
        .get_signed_in(&format!(
            "/api/v1/positions/closed?outcome=win&cursor={cursor}"
        ))
        .await;
    let resorted = app
        .get_signed_in(&format!(
            "/api/v1/positions/closed?sort=pnl&cursor={cursor}"
        ))
        .await;
    let invalid = [
        "/api/v1/positions/closed?day=yesterday".to_owned(),
        format!("/api/v1/positions/closed?search={}", "x".repeat(65)),
        format!("/api/v1/positions/closed?pool={pools}"),
        "/api/v1/positions/closed?outcome=breakeven".to_owned(),
        "/api/v1/pools?search=bonk&address=11111111111111111111111111111111".to_owned(),
    ];

    for response in [foreign, resorted] {
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
        assert_eq!(response.json()["error"]["code"], "invalid_cursor");
    }
    for path in invalid {
        let response = app.get_signed_in(&path).await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{path}");
        assert_eq!(
            response.json()["error"]["code"],
            "invalid_request",
            "{path}"
        );
    }
}

#[tokio::test]
async fn answers_data_not_ready_while_the_engine_serves_nothing() {
    let app = TestApp::new().await;

    for route in ["/api/v1/positions/closed", "/api/v1/pools"] {
        let response = app.get_signed_in(route).await;

        assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE, "{route}");
    }
}
