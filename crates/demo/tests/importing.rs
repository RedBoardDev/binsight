//! Synthetic imports preserve unknown progress and validate only percentages that are known.

#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use binsight_core::ratio::Percent;
use binsight_demo::{DemoError, DemoPortfolio, ImportingWalletSpec, WorldSpec};
use jiff::Timestamp;
use jiff::tz::TimeZone;

#[test]
fn rejects_known_percentages_outside_the_import_range() {
    let anchor: Timestamp = "2026-10-05T15:30:00Z".parse().unwrap();
    for progress in [-1, 100_000_001] {
        let mut spec = WorldSpec::new(anchor, TimeZone::UTC);
        spec.importing_wallet = Some(ImportingWalletSpec {
            wallet_index: 0,
            indexed_since: None,
            progress: Some(Percent(progress)),
        });
        assert!(matches!(
            DemoPortfolio::new(&spec),
            Err(DemoError::OutOfRange)
        ));
    }
}
