//! Reading the figures of a JSON answer as exact integers, so tests can add and compare them.

#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly"
)]

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

/// Every scope query: all wallets, then each wallet.
pub(crate) async fn scopes(app: &TestApp) -> Vec<String> {
    let wallets = app.get_signed_in("/api/v1/wallets").await.json();
    let mut scopes = vec!["all".to_owned()];
    for item in wallets["items"].as_array().unwrap() {
        scopes.push(item["wallet"]["address"].as_str().unwrap().to_owned());
    }
    scopes
}
