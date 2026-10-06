//! Reading the figures of a JSON answer as exact integers, so tests can add and compare them.

#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly"
)]

use axum::http::StatusCode;
use binsight_ledger::report::valued::{Money, MoneyUnit};
use serde_json::Value;

use super::TestApp;

/// A canonical decimal string as an integer of `decimals` decimals.
pub(crate) fn units(text: &str, decimals: usize) -> i128 {
    let (negative, digits) = text
        .strip_prefix('-')
        .map_or((false, text), |rest| (true, rest));
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let padded = format!("{fraction:0<decimals$}");
    let value: i128 = format!("{whole}{padded}").parse().unwrap();
    if negative { -value } else { value }
}

/// The amount of a figure, in its unit's smallest units.
pub(crate) fn amount(figure: &Value) -> i128 {
    let decimals = if figure["value"]["unit"] == "sol" {
        9
    } else {
        6
    };
    units(figure["value"]["amount"].as_str().unwrap(), decimals)
}

/// An HTTP JSON answer whose successful status is checked before reading its figures.
pub(crate) async fn get_ok(app: &TestApp, path: &str) -> Value {
    let response = app.get_signed_in(path).await;
    assert_eq!(response.status, StatusCode::OK, "{path}");
    response.json()
}

/// A figure's quality, including the absence of a fabricated unavailable value.
pub(crate) fn assert_quality(figure: &Value) {
    let exactness = figure["exactness"].as_str().unwrap();
    assert!(["complete", "partial", "estimated", "unavailable"].contains(&exactness));
    if exactness == "complete" {
        assert!(figure.get("value").is_some_and(|value| !value.is_null()));
        assert!(figure.get("reasons").is_none(), "{figure}");
        return;
    }
    let reasons = figure["reasons"].as_array().unwrap();
    assert_ne!(reasons, &Vec::<Value>::new(), "{figure}");
    assert!(reasons.iter().all(|reason| reason["code"].is_string()));
    if exactness == "unavailable" {
        assert!(figure.get("value").is_none(), "{figure}");
        return;
    }
    assert!(figure.get("value").is_some_and(|value| !value.is_null()));
}

/// A known canonical SOL or USD figure, without assigning any value to unavailable figures.
pub(crate) fn money(figure: &Value) -> Money {
    assert_quality(figure);
    let unit = match figure["value"]["unit"].as_str().unwrap() {
        "sol" => Some(MoneyUnit::Sol),
        "usd" => Some(MoneyUnit::Usd),
        _ => None,
    }
    .unwrap();
    let text = figure["value"]["amount"].as_str().unwrap();
    let decimals = usize::from(unit.decimals().0);
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    assert!(fraction.len() <= decimals, "{text}");
    let raw = format!("{whole}{fraction:0<decimals$}")
        .parse::<i128>()
        .unwrap();
    let money = Money { raw, unit };
    assert_eq!(money.to_decimal_string(), text);
    money
}

/// Every scope query: all wallets, then each wallet.
pub(crate) async fn scopes(app: &TestApp) -> Vec<String> {
    let wallets = get_ok(app, "/api/v1/wallets").await;
    let mut scopes = vec!["all".to_owned()];
    for item in wallets["items"].as_array().unwrap() {
        scopes.push(item["wallet"]["address"].as_str().unwrap().to_owned());
    }
    scopes
}
