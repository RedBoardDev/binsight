//! Real-PnL bars telescope at the HTTP boundary for every demo wallet, period and currency.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "HTTP tests fail loudly on missing or inconsistent figures"
)]

mod common;

use binsight_demo::ImportingWalletSpec;
use binsight_ledger::report::valued::{Money, MoneyUnit};
use serde_json::Value;

use common::figures::{assert_quality, get_ok, money, scopes};
use common::{Figures, TestApp, TestAppOptions};

const PERIODS: [&str; 6] = ["today", "7d", "1m", "3m", "1y", "all"];
const CURRENCIES: [(&str, MoneyUnit); 2] = [("sol", MoneyUnit::Sol), ("usd", MoneyUnit::Usd)];

fn assert_telescopes(series: &Value, overview: &Value, unit: MoneyUnit) {
    let points = series["points"].as_array().unwrap();
    assert_ne!(points, &Vec::<Value>::new());
    let mut sum = Money { raw: 0, unit };
    for point in points {
        let bar = money(&point["bar"]);
        let line = money(&point["line"]);
        assert_eq!(bar.unit, unit);
        assert_eq!(line.unit, unit);
        assert_quality(&point["bar_share_of_net_worth"]);
        assert_quality(&point["line_share_of_net_worth"]);
        sum.raw = sum.raw.checked_add(bar.raw).unwrap();
    }
    let last = points.last().unwrap();
    assert_eq!(sum, money(&last["line"]));
    assert_eq!(sum, money(&series["header"]["value"]));
    assert_eq!(sum, money(&overview["gain"]["value"]));
    assert_eq!(last["line"], series["header"]["value"]);
    assert_eq!(last["line"], overview["gain"]["value"]);
    assert_eq!(last["line_share_of_net_worth"], overview["gain"]["pct"]);
}

#[tokio::test]
async fn sums_real_pnl_bars_to_the_last_line_header_and_gain_in_every_scope() {
    let app = TestApp::demo().await;
    let scopes = scopes(&app).await;
    assert_eq!(scopes.len(), 4);
    for scope in scopes {
        for period in PERIODS {
            for (currency, unit) in CURRENCIES {
                let query = format!("wallet={scope}&period={period}&currency={currency}");
                let overview = get_ok(&app, &format!("/api/v1/overview?{query}")).await;
                let series = get_ok(
                    &app,
                    &format!("/api/v1/stats/series?series=real_pnl&{query}"),
                )
                .await;
                assert_eq!(series["series"], "real_pnl", "{query}");
                assert_eq!(series["window"], overview["gain"]["window"], "{query}");
                assert_telescopes(&series, &overview, unit);
            }
        }
    }
    assert_eq!((app.network_io)(), (0, 0));
}

fn assert_uncovered(figure: &Value, wallet: &str) {
    assert_quality(figure);
    assert_eq!(figure["exactness"], "unavailable");
    assert!(figure.get("value").is_none());
    assert!(
        figure["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| { reason["code"] == "history_incomplete" && reason["wallet"] == wallet })
    );
}

#[tokio::test]
async fn keeps_uncovered_real_pnl_bars_and_endpoints_unavailable_without_a_zero_sum() {
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
    let wallet = scopes(&app).await[1].clone();
    for scope in ["all", wallet.as_str()] {
        for (currency, _) in CURRENCIES {
            let query = format!("wallet={scope}&period=7d&currency={currency}");
            let overview = get_ok(&app, &format!("/api/v1/overview?{query}")).await;
            let series = get_ok(
                &app,
                &format!("/api/v1/stats/series?series=real_pnl&{query}"),
            )
            .await;
            assert_uncovered(&overview["gain"]["value"], &wallet);
            assert_eq!(series["header"]["value"], overview["gain"]["value"]);
            let points = series["points"].as_array().unwrap();
            assert_ne!(points, &Vec::<Value>::new());
            for point in points {
                assert_uncovered(&point["bar"], &wallet);
                assert_uncovered(&point["line"], &wallet);
                assert_quality(&point["bar_share_of_net_worth"]);
                assert_quality(&point["line_share_of_net_worth"]);
            }
            assert_eq!(points.last().unwrap()["line"], overview["gain"]["value"]);
        }
    }
    assert_eq!((app.network_io)(), (0, 0));
}
