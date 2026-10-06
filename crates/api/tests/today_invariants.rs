//! Today's realized closes share their totals across HTTP views, independently of real-PnL bars.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "HTTP tests fail loudly on missing or inconsistent figures"
)]

mod common;

use common::TestApp;
use common::figures::{get_ok, money, scopes};
use serde_json::Value;

fn assert_today(today: &Value, recent_day: &Value, history: &Value, series: &Value) -> bool {
    for bound in ["start", "end", "timezone"] {
        assert_eq!(today["window"][bound], recent_day["window"][bound]);
    }
    assert_eq!(today["totals"], recent_day["totals"]);
    let groups = history["day_groups"].as_array().unwrap();
    assert_eq!(groups.len(), 1, "fixture needs a close today");
    assert_eq!(groups[0]["day"], recent_day["day"]);
    assert_eq!(groups[0]["count"], today["totals"]["count"]);
    let today_pnl = &today["totals"]["pnl"];
    assert_eq!(groups[0]["pnl"], *today_pnl);
    assert_eq!(history["matched_count"], today["totals"]["count"]);
    let realized = money(today_pnl);
    let points = series["points"].as_array().unwrap();
    assert_eq!(points.len(), 1);
    let real_pnl = money(&points[0]["bar"]);
    assert_eq!(real_pnl.unit, realized.unit);
    real_pnl != realized
}

#[tokio::test]
async fn keeps_today_equal_to_recent_closes_and_history_without_equating_it_to_real_pnl() {
    let app = TestApp::demo().await;
    let scopes = scopes(&app).await;
    assert_eq!(scopes.len(), 4);
    let mut distinct_real_pnl_cases = 0;
    for scope in scopes {
        for currency in ["sol", "usd"] {
            let query = format!("wallet={scope}&currency={currency}");
            let overview = get_ok(&app, &format!("/api/v1/overview?period=all&{query}")).await;
            let recent = get_ok(&app, &format!("/api/v1/positions/recent-closes?{query}")).await;
            let recent_day = &recent["days"][0];
            let day = recent_day["day"].as_str().unwrap();
            let history = get_ok(
                &app,
                &format!("/api/v1/positions/closed?day={day}&sort=closed_at&limit=1&{query}"),
            )
            .await;
            let series = get_ok(
                &app,
                &format!("/api/v1/stats/series?series=real_pnl&period=today&{query}"),
            )
            .await;
            if assert_today(&overview["today"], recent_day, &history, &series) {
                distinct_real_pnl_cases += 1;
            }
        }
    }
    assert!(distinct_real_pnl_cases > 0);
    assert_eq!((app.network_io)(), (0, 0));
}
