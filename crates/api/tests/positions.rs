//! The position drawer on the demo world: every listed position opens by its id with the same
//! figures, its movements add up and page cleanly, and its candles hold its markers.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly"
)]

mod common;

use axum::http::StatusCode;
use common::TestApp;
use common::figures::amount;
use common::positions::{detail, listed_positions};
use serde_json::Value;

/// Every movement of a position, read a page of `limit` at a time, in `currency`.
async fn all_events(app: &TestApp, id: &str, limit: usize, currency: &str) -> Vec<Value> {
    let mut events = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let after = cursor.map_or(String::new(), |cursor| format!("&cursor={cursor}"));
        let path =
            format!("/api/v1/positions/{id}/events?limit={limit}&currency={currency}{after}");
        let page = app.get_signed_in(&path).await.json();
        events.extend(page["items"].as_array().unwrap().iter().cloned());
        match page["next_cursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => return events,
        }
    }
}

/// The currency a position's amounts are native in: SOL for a SOL pool, dollars for a
/// stablecoin pool.
fn native_currency(row: &Value) -> &'static str {
    if row["pool"]["quote_kind"] == "sol" {
        "sol"
    } else {
        "usd"
    }
}

#[tokio::test]
async fn opens_every_listed_position_by_its_id_with_the_same_figures() {
    let app = TestApp::demo().await;

    for row in listed_positions(&app).await {
        let id = row["id"].as_str().unwrap();
        let mut position = detail(&app, id).await;
        let object = position.as_object_mut().unwrap();
        let status = object.remove("status").unwrap();
        object.remove("chart").unwrap();
        object.remove("freshness");

        let expected = if row.get("closed_at").is_some() {
            "closed"
        } else {
            "open"
        };
        assert_eq!(status, expected, "{id}");
        assert_eq!(position, row, "{id}");
    }
}

#[tokio::test]
async fn measures_a_closed_position_by_its_own_flat_figures() {
    let app = TestApp::demo().await;

    for row in listed_positions(&app).await {
        if row.get("closed_at").is_none() {
            continue;
        }
        let lp_pnl = amount(&row["withdrawn"]) + amount(&row["fees"]) - amount(&row["invested"]);

        assert_eq!(amount(&row["lp_pnl"]), lp_pnl, "{}", row["id"]);
        if row["method"] == "fifo" {
            assert_eq!(row["pnl"], row["market_pnl"]);
        } else {
            assert_eq!(row["pnl"], row["lp_pnl"]);
            assert!(row["market_pnl"].is_null());
        }
    }
}

#[tokio::test]
async fn adds_the_movements_of_a_position_up_to_its_figures_in_its_native_unit() {
    let app = TestApp::demo().await;

    for listed in listed_positions(&app).await {
        let id = listed["id"].as_str().unwrap();
        let currency = native_currency(&listed);
        let row = app
            .get_signed_in(&format!("/api/v1/positions/{id}?currency={currency}"))
            .await
            .json();
        let events = all_events(&app, id, 200, currency).await;
        let sum = |kinds: &[&str]| -> i128 {
            events
                .iter()
                .filter(|event| kinds.contains(&event["kind"].as_str().unwrap()))
                .map(|event| amount(&event["value"]))
                .sum()
        };

        let claimed = if row["status"] == "closed" {
            &row["fees"]
        } else {
            &row["claimed_fees"]
        };
        assert_eq!(sum(&["open", "add"]), amount(&row["invested"]), "{id}");
        assert_eq!(sum(&["remove", "close"]), amount(&row["withdrawn"]), "{id}");
        assert_eq!(sum(&["claim"]), amount(claimed), "{id}");
        assert_eq!(events.last().unwrap()["kind"], "open", "{id}");
    }
}

#[tokio::test]
async fn pages_the_movements_without_overlap_or_gap() {
    let app = TestApp::demo().await;

    for row in listed_positions(&app).await.into_iter().take(6) {
        let id = row["id"].as_str().unwrap();

        let whole = all_events(&app, id, 200, "sol").await;
        let paged = all_events(&app, id, 1, "sol").await;

        assert_eq!(paged, whole, "{id}");
    }
}

#[tokio::test]
async fn refuses_a_cursor_of_another_position_or_garbage() {
    let app = TestApp::demo().await;
    let rows = listed_positions(&app).await;
    let (first, second) = (
        rows[0]["id"].as_str().unwrap(),
        rows[1]["id"].as_str().unwrap(),
    );
    let page = app
        .get_signed_in(&format!("/api/v1/positions/{first}/events?limit=1"))
        .await
        .json();
    let cursor = page["next_cursor"].as_str().unwrap();

    let foreign = app
        .get_signed_in(&format!(
            "/api/v1/positions/{second}/events?cursor={cursor}"
        ))
        .await;
    let garbage = app
        .get_signed_in(&format!("/api/v1/positions/{first}/events?cursor=garbage"))
        .await;

    for response in [foreign, garbage] {
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
        assert_eq!(response.json()["error"]["code"], "invalid_cursor");
    }
}

#[tokio::test]
async fn answers_position_not_found_for_an_unknown_id_and_refuses_a_malformed_one() {
    let app = TestApp::demo().await;
    let address = "11111111111111111111111111111111";
    let signature = "1".repeat(64);

    let unknown = app
        .get_signed_in(&format!("/api/v1/positions/{address}-{signature}"))
        .await;
    let malformed = app.get_signed_in("/api/v1/positions/not-an-id").await;

    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    assert_eq!(unknown.json()["error"]["code"], "position_not_found");
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);
    assert_eq!(malformed.json()["error"]["code"], "invalid_request");
}

#[tokio::test]
async fn shows_a_closed_position_with_its_chart() {
    let app = TestApp::demo().await;
    let recent = app
        .get_signed_in("/api/v1/positions/recent-closes")
        .await
        .json();
    let id = recent["days"][0]["items"][0]["id"].as_str().unwrap();

    insta::assert_json_snapshot!("demo_closed_position", detail(&app, id).await);
}

#[tokio::test]
async fn answers_data_not_ready_while_the_engine_serves_nothing() {
    let app = TestApp::new().await;
    let id = format!("{}-{}", "1".repeat(32), "1".repeat(64));
    let routes = [
        format!("/api/v1/positions/{id}"),
        format!("/api/v1/positions/{id}/events"),
        format!("/api/v1/positions/{id}/candles"),
    ];
    for route in routes {
        let response = app.get_signed_in(&route).await;

        assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE, "{route}");
    }
}
