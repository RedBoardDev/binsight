//! A key from one conversion source never silently pages a differently valued snapshot.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly"
)]

mod common;

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::http::StatusCode;
use binsight_engine::portfolio::query::ClosedPageRequest;
use binsight_solana::Address;
use common::history_rates::{ChangingHistory, query};
use common::{TestApp, TestAppOptions};

async fn app(source: &Arc<ChangingHistory>) -> TestApp {
    TestApp::with(TestAppOptions {
        read_model: Some(source.clone()),
        ..TestAppOptions::default()
    })
    .await
}

#[tokio::test]
async fn rejects_changed_rates_that_would_skip_an_unread_position() {
    let source = Arc::new(ChangingHistory::new(400_000_000, false, ["UTC", "UTC"]));
    let first = source.page(
        &query(),
        ClosedPageRequest {
            as_of: None,
            after: None,
            limit: 1,
        },
    );
    let all = source.page(
        &query(),
        ClosedPageRequest {
            as_of: None,
            after: None,
            limit: 200,
        },
    );
    assert_eq!(first.items[0].pool.address, Address::from_bytes([4; 32]));
    assert_eq!(first.conversion_rates.len(), 1);
    source.switch(1);
    let unguarded = source.page(
        &query(),
        ClosedPageRequest {
            as_of: Some(first.as_of),
            after: first.next,
            limit: 200,
        },
    );
    let expected: BTreeSet<_> = all.items.iter().map(|row| row.id).collect();
    let observed: BTreeSet<_> = first
        .items
        .iter()
        .chain(&unguarded.items)
        .map(|row| row.id)
        .collect();
    assert_eq!(expected.len(), 4);
    assert_eq!(observed.len(), 3);
    assert_ne!(observed, expected);

    source.switch(0);
    let app = app(&source).await;
    let first = app
        .get_signed_in("/api/v1/positions/closed?sort=pnl&currency=usd&limit=1")
        .await
        .json();
    source.switch(1);
    let cursor = first["next_cursor"].as_str().unwrap();
    let response = app
        .get_signed_in(&format!(
            "/api/v1/positions/closed?sort=pnl&currency=usd&limit=1&cursor={cursor}"
        ))
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["error"]["code"], "invalid_cursor");
    assert!(response.json().get("items").is_none());
}

#[tokio::test]
async fn concatenates_pages_across_snapshots_with_identical_conversion_sources() {
    let source = Arc::new(ChangingHistory::new(200_000_000, false, ["UTC", "UTC"]));
    let app = app(&source).await;
    let mut cursor = String::new();
    let mut ids = BTreeSet::new();
    let mut count = 0;
    loop {
        let response = app
            .get_signed_in(&format!(
                "/api/v1/positions/closed?sort=pnl&currency=usd&limit=1{cursor}"
            ))
            .await;
        assert_eq!(response.status, StatusCode::OK);
        let page = response.json();
        assert_eq!(page["matched_count"], 4);
        for row in page["items"].as_array().unwrap() {
            assert!(ids.insert(row["id"].as_str().unwrap().to_owned()));
            count += 1;
        }
        source.switch(1);
        match page["next_cursor"].as_str() {
            Some(next) => cursor = format!("&cursor={next}"),
            None => break,
        }
    }
    assert_eq!(count, 4);
    assert_eq!(ids.len(), 4);
}

#[tokio::test]
async fn rejects_a_final_close_replacing_the_same_numeric_provisional_rate() {
    let source = Arc::new(ChangingHistory::new(200_000_000, true, ["UTC", "UTC"]));
    let app = app(&source).await;
    let first = app
        .get_signed_in("/api/v1/positions/closed?sort=pnl&currency=usd&limit=1")
        .await
        .json();
    source.switch(1);
    let cursor = first["next_cursor"].as_str().unwrap();
    let response = app
        .get_signed_in(&format!(
            "/api/v1/positions/closed?sort=pnl&currency=usd&limit=1&cursor={cursor}"
        ))
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["error"]["code"], "invalid_cursor");
}

#[tokio::test]
async fn preserves_native_currency_cursors_when_the_unused_rate_changes() {
    for (pool, currency) in [(3, "sol"), (4, "usd")] {
        let source = Arc::new(ChangingHistory::new(400_000_000, false, ["UTC", "UTC"]));
        let app = app(&source).await;
        let pool = Address::from_bytes([pool; 32]);
        let query = format!("sort=pnl&currency={currency}&pool={pool}&limit=1");
        let first = app
            .get_signed_in(&format!("/api/v1/positions/closed?{query}"))
            .await
            .json();
        source.switch(1);
        let cursor = first["next_cursor"].as_str().unwrap();
        let response = app
            .get_signed_in(&format!("/api/v1/positions/closed?{query}&cursor={cursor}"))
            .await;
        assert_eq!(response.status, StatusCode::OK);
        let second = response.json();
        assert_eq!(second["matched_count"], 2);
        assert_ne!(first["items"][0]["id"], second["items"][0]["id"]);
        assert!(second["next_cursor"].is_null());
    }
}

#[tokio::test]
async fn rejects_a_timezone_change_after_a_half_hour_local_day_read() {
    let source = Arc::new(ChangingHistory::new(
        200_000_000,
        false,
        ["Asia/Kolkata", "UTC"],
    ));
    let app = app(&source).await;
    let now = jiff::Timestamp::from_second(common::START_SECONDS).unwrap();
    let day = now
        .to_zoned(jiff::tz::TimeZone::get("Asia/Kolkata").unwrap())
        .date();
    let query = format!("sort=closed_at&currency=usd&limit=1&day={day}");
    let first = app
        .get_signed_in(&format!("/api/v1/positions/closed?{query}"))
        .await
        .json();
    assert_eq!(first["day_groups"][0]["day"], day.to_string());
    assert_eq!(first["day_groups"][0]["count"], 4);
    source.switch(1);
    let cursor = first["next_cursor"].as_str().unwrap();
    let response = app
        .get_signed_in(&format!("/api/v1/positions/closed?{query}&cursor={cursor}"))
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["error"]["code"], "invalid_cursor");
}
