//! History on the demo world, through the read port: a list read at an earlier instant leaves
//! out the later closes, so the pages of one scroll never change under the reader.

#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use std::collections::BTreeSet;
use std::sync::Arc;

use binsight_core::clock::FixedClock;
use binsight_demo::{DemoPortfolio, WorldSpec};
use binsight_engine::portfolio::query::{ClosedPageRequest, ClosedQuery, ClosedSort, SortOrder};
use binsight_engine::portfolio::{HistoryReads, Scope};
use binsight_ledger::report::valued::Currency;
use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp};

const ANCHOR: &str = "2026-10-04T15:30:00Z";

fn portfolio() -> DemoPortfolio {
    let anchor: Timestamp = ANCHOR.parse().unwrap();
    let spec = WorldSpec::new(anchor, TimeZone::get("Europe/Paris").unwrap());
    DemoPortfolio::new(&spec, Arc::new(FixedClock::new(anchor))).unwrap()
}

fn every_close() -> ClosedQuery {
    ClosedQuery {
        scope: Scope::All,
        day: None,
        search: None,
        outcomes: BTreeSet::new(),
        strategies: BTreeSet::new(),
        pools: BTreeSet::new(),
        sort: ClosedSort::ClosedAt,
        order: SortOrder::Descending,
        currency: Currency::Sol,
    }
}

#[tokio::test]
async fn leaves_out_the_closes_after_the_instant_of_the_list() {
    let portfolio = portfolio();
    let earlier = ANCHOR
        .parse::<Timestamp>()
        .unwrap()
        .checked_sub(SignedDuration::from_hours(36))
        .unwrap();
    let page = |as_of| ClosedPageRequest {
        as_of,
        after: None,
        limit: 200,
    };

    let now = portfolio
        .closed_page(every_close(), page(None))
        .await
        .unwrap();
    let then = portfolio
        .closed_page(every_close(), page(Some(earlier)))
        .await
        .unwrap();

    assert_eq!(then.as_of, earlier);
    assert!(then.matched_count < now.matched_count);
    assert_eq!(then.matched_count, then.total_count);
    assert!(then.items.iter().all(|row| row.closed_at <= earlier));
}
