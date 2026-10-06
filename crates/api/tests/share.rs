//! Position share cards reuse the authenticated detail read and its source instant.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "HTTP tests compare the wire projection with its source"
)]

mod common;
#[path = "share/schema.rs"]
mod schema;

use axum::http::StatusCode;
use binsight_core::clock::Clock;
use binsight_demo::ImportingWalletSpec;
use common::positions::listed_positions;
use common::{Figures, START_SECONDS, TestApp, TestAppOptions};
use jiff::Timestamp;
use serde_json::Value;

#[tokio::test]
async fn serves_a_position_share_card_from_the_existing_detail() {
    let app = TestApp::demo().await;
    let rows = listed_positions(&app).await;
    let id = rows[0]["id"].as_str().unwrap();
    let response = app
        .get_signed_in(&format!("/api/v1/share/positions/{id}"))
        .await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json()["id"], id);
    assert_eq!((app.network_io)(), (0, 0));
}

const CARD_FIELDS: [&str; 17] = [
    "status",
    "id",
    "address",
    "pool",
    "wallet",
    "strategy",
    "pnl",
    "pnl_kind",
    "pnl_pct",
    "method",
    "opened_at",
    "closed_at",
    "held_seconds",
    "invested",
    "fees",
    "bins",
    "range",
];

async fn card(app: &TestApp, id: &str, currency: &str) -> Value {
    let response = app
        .get_signed_in(&format!("/api/v1/share/positions/{id}?currency={currency}"))
        .await;
    assert_eq!(response.status, StatusCode::OK, "{id}/{currency}");
    let card = response.json();
    let object = card.as_object().unwrap();
    assert_eq!(object.len(), CARD_FIELDS.len());
    for field in CARD_FIELDS {
        assert!(object.contains_key(field), "missing {field}");
    }
    card
}

async fn closed_positions(app: &TestApp) -> Vec<Value> {
    let mut rows = Vec::new();
    let mut cursor = String::new();
    loop {
        let page = app
            .get_signed_in(&format!("/api/v1/positions/closed?limit=200{cursor}"))
            .await
            .json();
        rows.extend(page["items"].as_array().unwrap().iter().cloned());
        match page["next_cursor"].as_str() {
            Some(next) => cursor = format!("&cursor={next}"),
            None => return rows,
        }
    }
}

async fn assert_matches_detail(app: &TestApp, id: &str, currency: &str) -> Value {
    let card = card(app, id, currency).await;
    let response = app
        .get_signed_in(&format!("/api/v1/positions/{id}?currency={currency}"))
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let detail = response.json();
    for field in [
        "status",
        "id",
        "address",
        "pool",
        "wallet",
        "strategy",
        "pnl",
        "pnl_pct",
        "method",
        "opened_at",
        "invested",
        "fees",
    ] {
        assert_eq!(card[field], detail[field], "{id}/{currency}/{field}");
    }
    let opened: Timestamp = detail["opened_at"].as_str().unwrap().parse().unwrap();
    if card["status"] == "open" {
        assert_eq!(card["pnl_kind"], "open");
        assert_eq!(card["method"], "pool");
        assert!(card["closed_at"].is_null());
        assert_eq!(card["bins"], detail["bins"]);
        assert_eq!(card["range"], detail["range"]);
        let anchor = Timestamp::from_second(START_SECONDS).unwrap();
        assert_eq!(
            card["held_seconds"],
            anchor.duration_since(opened).as_secs()
        );
    } else {
        assert_eq!(card["pnl_kind"], "realized");
        assert_eq!(card["closed_at"], detail["closed_at"]);
        assert_eq!(card["held_seconds"], detail["held_seconds"]);
        assert!(card["bins"].is_null());
        assert!(card["range"].is_null());
    }
    card
}

#[tokio::test]
async fn preserves_every_detail_field_and_quality_in_both_currencies() {
    let app = TestApp::demo().await;
    let mut rows = listed_positions(&app).await;
    let history = closed_positions(&app).await;
    rows.extend(
        history
            .iter()
            .filter(|row| row["pnl"]["exactness"] != "complete")
            .take(8)
            .cloned(),
    );
    rows.extend(history.iter().find(|row| row["method"] == "fifo").cloned());
    let mut methods = std::collections::BTreeSet::new();
    let mut has_provisional = false;
    let mut has_unpriced_leg = false;
    for row in rows {
        let id = row["id"].as_str().unwrap();
        for currency in ["sol", "usd"] {
            let card = assert_matches_detail(&app, id, currency).await;
            methods.insert(card["method"].as_str().unwrap().to_owned());
            has_unpriced_leg |= card["pnl"]["reasons"].as_array().is_some_and(|reasons| {
                reasons
                    .iter()
                    .any(|reason| reason["code"] == "unpriced_leg")
            });
            has_provisional |= card["pnl"]["reasons"].as_array().is_some_and(|reasons| {
                reasons
                    .iter()
                    .any(|reason| reason["code"] == "provisional_rate")
            });
        }
    }
    assert!(methods.contains("pool"));
    assert!(methods.contains("fifo"));
    assert!(has_provisional);
    assert!(has_unpriced_leg);
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn uses_sol_when_the_currency_parameter_is_absent() {
    let app = TestApp::demo().await;
    let rows = listed_positions(&app).await;
    for row in rows.into_iter().take(9) {
        let id = row["id"].as_str().unwrap();
        let default = app
            .get_signed_in(&format!("/api/v1/share/positions/{id}"))
            .await;
        assert_eq!(default.status, StatusCode::OK);
        assert_eq!(default.json(), card(&app, id, "sol").await);
    }
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn protects_share_cards_and_normalizes_invalid_and_missing_position_errors() {
    let app = TestApp::demo().await;
    let id = format!("{}-{}", "1".repeat(32), "1".repeat(64));
    let path = format!("/api/v1/share/positions/{id}");
    let unsigned = app.get(&path).await;
    assert_eq!(unsigned.status, StatusCode::UNAUTHORIZED);
    assert_eq!(unsigned.json()["error"]["code"], "unauthenticated");
    for (path, status, code) in [
        (path.clone(), StatusCode::NOT_FOUND, "position_not_found"),
        (
            "/api/v1/share/positions/invalid".into(),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            format!("{path}?currency=eur"),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
    ] {
        let response = app.get_signed_in(&path).await;
        assert_eq!(response.status, status);
        let error = response.json();
        assert_eq!(error["error"]["code"], code);
        assert_eq!(
            error["error"]["request_id"],
            response.header("x-request-id").unwrap()
        );
    }
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn returns_data_not_ready_without_fabricating_a_share_card() {
    let app = TestApp::new().await;
    let id = format!("{}-{}", "1".repeat(32), "1".repeat(64));
    let response = app
        .get_signed_in(&format!("/api/v1/share/positions/{id}"))
        .await;
    assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
    let body = response.json();
    assert_eq!(body["error"]["code"], "data_not_ready");
    assert!(body.get("pnl").is_none());
    assert_eq!(
        body["error"]["request_id"],
        response.header("x-request-id").unwrap()
    );
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn keeps_distinct_lives_of_the_same_physical_account() {
    let app = TestApp::demo().await;
    let rows = closed_positions(&app).await;
    let pair = rows
        .iter()
        .find_map(|first| {
            rows.iter()
                .find(|second| first["address"] == second["address"] && first["id"] != second["id"])
                .map(|second| (first, second))
        })
        .expect("the demo recreates a physical account");
    let first = card(&app, pair.0["id"].as_str().unwrap(), "sol").await;
    let second = card(&app, pair.1["id"].as_str().unwrap(), "sol").await;
    assert_eq!(first["address"], second["address"]);
    assert_ne!(first["id"], second["id"]);
    assert_eq!(first["opened_at"], pair.0["opened_at"]);
    assert_eq!(second["opened_at"], pair.1["opened_at"]);
    assert_ne!(first["opened_at"], second["opened_at"]);
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn preserves_import_quality_and_holding_time_after_auth_midnight() {
    let app = TestApp::with(TestAppOptions {
        figures: Figures::Demo,
        importing_wallet: Some(ImportingWalletSpec {
            wallet_index: 0,
            indexed_since: None,
            progress: None,
        }),
        ..TestAppOptions::default()
    })
    .await;
    let rows = listed_positions(&app).await;
    let row = rows
        .iter()
        .find(|row| row["pnl"]["exactness"] == "estimated")
        .expect("an importing wallet has estimated open figures");
    let id = row["id"].as_str().unwrap();
    let before = assert_matches_detail(&app, id, "sol").await;
    assert_eq!(before["pnl"]["exactness"], "estimated");
    let anchor = app.clock.now();
    app.advance_clock(86_400);
    assert_ne!(app.clock.now().as_second(), anchor.as_second());
    let after = card(&app, id, "sol").await;
    assert_eq!(after, before);
    assert_eq!((app.network_io)(), (0, 0));
}
