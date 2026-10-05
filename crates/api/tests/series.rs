//! The chart series on the demo world: they end on the overview's gain and their bars add up.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly"
)]

mod common;

use common::TestApp;
use common::figures::amount;

const CURRENCIES: [&str; 2] = ["sol", "usd"];
const PERIODS: [&str; 6] = ["today", "7d", "1m", "3m", "1y", "all"];

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
