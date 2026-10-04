//! Reading the positions of the demo world through the API, for the drawer tests.

#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly"
)]

use axum::http::StatusCode;
use serde_json::Value;

use super::TestApp;

/// Every position the overview lists: the open ones, then today's and yesterday's closes.
pub(crate) async fn listed_positions(app: &TestApp) -> Vec<Value> {
    let open = app.get_signed_in("/api/v1/positions/open").await.json();
    let recent = app
        .get_signed_in("/api/v1/positions/recent-closes")
        .await
        .json();
    let mut rows: Vec<Value> = open["items"].as_array().unwrap().clone();
    for day in recent["days"].as_array().unwrap() {
        rows.extend(day["items"].as_array().unwrap().iter().cloned());
    }
    rows
}

pub(crate) async fn detail(app: &TestApp, id: &str) -> Value {
    let response = app.get_signed_in(&format!("/api/v1/positions/{id}")).await;
    assert_eq!(response.status, StatusCode::OK, "{id}");
    response.json()
}
