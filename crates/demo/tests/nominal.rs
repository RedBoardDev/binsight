//! The nominal demo world: the calm instance a screen is compared against. Every wallet is live
//! and tracked since its first activity; the trades and holdings are the showcase's.

#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use binsight_demo::{DemoPortfolio, WorldProfile, WorldSpec};
use binsight_engine::portfolio::views::SyncState;
use binsight_engine::portfolio::{InstanceReads, WalletReads};
use binsight_ledger::report::valued::Currency;
use jiff::Timestamp;
use jiff::tz::TimeZone;

const ANCHOR: &str = "2026-10-06T14:30:00Z";

fn world(profile: WorldProfile) -> DemoPortfolio {
    let mut spec = WorldSpec::new(ANCHOR.parse::<Timestamp>().unwrap(), TimeZone::UTC);
    spec.profile = profile;
    DemoPortfolio::new(&spec).unwrap()
}

#[tokio::test]
async fn keeps_every_wallet_live_in_the_nominal_world() {
    let report = world(WorldProfile::Nominal).sync_report().await.unwrap();

    assert_eq!(report.state, SyncState::Live);
    assert!(
        report
            .wallets
            .iter()
            .all(|line| line.sync.state == SyncState::Live)
    );
}

#[tokio::test]
async fn holds_the_same_positions_and_net_worth_as_the_showcase() {
    let nominal = world(WorldProfile::Nominal)
        .wallets(Currency::Sol)
        .await
        .unwrap();
    let showcase = world(WorldProfile::Showcase)
        .wallets(Currency::Sol)
        .await
        .unwrap();

    assert_eq!(nominal.total.positions, showcase.total.positions);
    assert!(nominal.total.positions.is_some());
    assert_eq!(nominal.total.net_worth, showcase.total.net_worth);
}
