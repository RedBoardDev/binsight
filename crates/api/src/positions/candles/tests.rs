//! Candle cache policy: source failures remain retryable even after a position closes.

use super::*;

#[test]
fn only_caches_fresh_final_candles() {
    let instant: Timestamp = "2026-10-04T12:00:00Z".parse().unwrap();
    let statuses = [
        views::CandleStatus::Fresh,
        views::CandleStatus::Stale {
            fetched_at: instant,
        },
        views::CandleStatus::Unavailable {
            reason: views::CandlesUnavailable::SourceUnreachable,
            retry_after_seconds: Some(60),
        },
    ];
    for status in statuses {
        for is_final in [false, true] {
            let view = views::CandlesView {
                interval: views::CandleInterval::OneHour,
                from: instant,
                to: instant,
                quote: None,
                source: views::CandleSource::GeckoTerminal,
                status,
                is_final,
                candles: Vec::new(),
            };
            let expected = match (status, is_final) {
                (views::CandleStatus::Fresh, true) => CACHE_FINAL,
                _ => CACHE_LIVE,
            };
            assert_eq!(
                cache_policy(&view),
                expected,
                "{status:?}, final={is_final}"
            );
        }
    }
}
