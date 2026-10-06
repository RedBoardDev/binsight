//! Overview v1 keeps its integer contract; v2 exposes unknown raw-fee classifications explicitly.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly on malformed fixtures"
)]

mod common;
#[path = "overview_versions/source.rs"]
mod source;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use binsight_solana::Address;
use common::{TestApp, TestAppOptions};
use source::FeeOverview;
use std::sync::Arc;

async fn app() -> (TestApp, Arc<FeeOverview>) {
    let source = Arc::new(FeeOverview::new());
    let app = TestApp::with(TestAppOptions {
        read_model: Some(source.clone()),
        ..TestAppOptions::default()
    })
    .await;
    (app, source)
}

#[tokio::test]
async fn keeps_known_positive_and_zero_counts_identical_in_both_versions() {
    let (app, source) = app().await;
    for (wallet, expected, fees) in [(4, 1, "0.000001"), (6, 0, "0")] {
        let address = Address::from_bytes([wallet; 32]);
        let v1 = app
            .get_signed_in(&format!("/api/v1/overview?wallet={address}&currency=usd"))
            .await;
        let v2 = app
            .get_signed_in(&format!("/api/v2/overview?wallet={address}&currency=usd"))
            .await;
        assert_eq!(v1.status, StatusCode::OK);
        assert_eq!(v2.status, StatusCode::OK);
        assert_eq!(v1.json(), v2.json());
        assert_eq!(v1.json()["open"]["unclaimed_position_count"], expected);
        assert_eq!(v1.json()["open"]["unclaimed_fees"]["value"]["amount"], fees);
    }
    assert_eq!(source.reads(), 4);
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn v1_refuses_unknown_count_while_v2_keeps_the_other_figures_and_required_null() {
    let (app, source) = app().await;
    for query in [
        "?currency=usd".to_owned(),
        format!("?wallet={}&currency=usd", Address::from_bytes([5; 32])),
    ] {
        let v1 = app.get_signed_in(&format!("/api/v1/overview{query}")).await;
        assert_eq!(v1.status, StatusCode::SERVICE_UNAVAILABLE);
        let error = v1.json();
        assert_eq!(error["error"]["code"], "data_not_ready");
        let request_id = error["error"]["request_id"].as_str().unwrap();
        assert_ne!(request_id, "");
        assert_eq!(v1.header("x-request-id"), Some(request_id));
        assert!(
            !error["error"]["message"]
                .as_str()
                .unwrap()
                .contains("fee position count")
        );
        let v2 = app.get_signed_in(&format!("/api/v2/overview{query}")).await;
        assert_eq!(v2.status, StatusCode::OK);
        let value = v2.json();
        assert!(
            value["open"]
                .as_object()
                .unwrap()
                .contains_key("unclaimed_position_count")
        );
        assert!(value["open"]["unclaimed_position_count"].is_null());
        assert!(value["open"]["count"].as_u64().unwrap() > 0);
        assert_eq!(value["open"]["unclaimed_fees"]["exactness"], "partial");
        assert_eq!(value["net_worth"]["lp"]["exactness"], "complete");
    }
    assert_eq!(source.reads(), 4);
    assert_eq!((app.network_io)(), (0, 0));
}

#[tokio::test]
async fn protects_v2_and_keeps_api_errors_for_wrong_methods_and_paths() {
    let (app, source) = app().await;
    assert_eq!(
        app.get("/api/v2/overview").await.status,
        StatusCode::UNAUTHORIZED
    );
    let cookie = app.session_cookie().await;
    let wrong_method = app
        .send(
            Request::post("/api/v2/overview")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(wrong_method.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(wrong_method.json()["error"]["code"], "method_not_allowed");
    let missing = app.get_signed_in("/api/v2/missing").await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.json()["error"]["code"], "not_found");
    assert_eq!(source.reads(), 0);
    assert_eq!((app.network_io)(), (0, 0));
}
