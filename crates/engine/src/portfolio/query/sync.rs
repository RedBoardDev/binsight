//! The synchronization report: the worst wallet state, the chain tip and the month's credits.

use binsight_core::ratio::Percent;
use jiff::Timestamp;
use jiff::tz::TimeZone;

use crate::portfolio::instance_status::InstanceStatus;
use crate::portfolio::read_error::ReadError;
use crate::portfolio::snapshot::Snapshot;
use crate::portfolio::views::{CreditsSummary, SyncReport, SyncState, WalletRef, WalletSyncLine};

/// The synchronization of the instance at `now`.
///
/// # Errors
///
/// Returns [`ReadError::Rule`] when the credit budget is zero.
pub fn sync_report(
    snapshot: &Snapshot,
    status: &InstanceStatus,
    now: Timestamp,
) -> Result<SyncReport, ReadError> {
    let wallets: Vec<WalletSyncLine> = snapshot
        .wallets()
        .iter()
        .map(|wallet| WalletSyncLine {
            wallet: WalletRef {
                address: wallet.facts.address,
                label: wallet.label.clone(),
                color: wallet.color,
            },
            sync: wallet.sync.clone(),
        })
        .collect();
    let state = wallets
        .iter()
        .map(|line| line.sync.state)
        .max()
        .unwrap_or(SyncState::Live);
    Ok(SyncReport {
        state,
        engine: status.engine,
        as_of: now,
        started_at: status.started_at,
        chain: status.chain,
        valuation_interval_seconds: status.valuation_interval_seconds,
        credits: credits(status, now)?,
        wallets,
    })
}

/// The credits of the UTC month of `now`, projected to its end at the pace of its elapsed days.
fn credits(status: &InstanceStatus, now: Timestamp) -> Result<CreditsSummary, ReadError> {
    let today = now.to_zoned(TimeZone::UTC).date();
    let days_in_month = u64::try_from(today.days_in_month()).unwrap_or(1);
    let elapsed_days = u64::try_from(today.day()).unwrap_or(1).max(1);
    let projected = status
        .credits_used
        .saturating_mul(days_in_month)
        .checked_div(elapsed_days)
        .unwrap_or(status.credits_used);
    Ok(CreditsSummary {
        year: today.year(),
        month: today.month(),
        used: status.credits_used,
        budget: status.credits_budget,
        used_percent: Percent::of(
            i128::from(status.credits_used),
            i128::from(status.credits_budget),
        )?,
        projected,
        is_over_budget: projected > status.credits_budget,
    })
}

#[cfg(test)]
mod tests {
    use binsight_core::units::Lamports;
    use binsight_ledger::facts::{HistoryCoverage, WalletFacts, WalletHoldings};
    use binsight_solana::Address;

    use super::*;
    use crate::portfolio::snapshot::{SnapshotFacts, TrackedWallet};
    use crate::portfolio::views::{ChainTip, WalletColor, WalletSync};
    use crate::portfolio::wallet_label::WalletLabel;
    use crate::status::EngineStatus;

    fn wallet(byte: u8, state: SyncState) -> TrackedWallet {
        let address = Address::from_bytes([byte; 32]);
        TrackedWallet {
            facts: WalletFacts {
                address,
                added_at: Timestamp::UNIX_EPOCH,
                history: HistoryCoverage::Complete,
            },
            label: WalletLabel::short_address(&address),
            color: WalletColor::Wallet1,
            holdings: WalletHoldings {
                wallet: address,
                idle: Lamports(0),
                recoverable_rent: Lamports(0),
                unpriced: Vec::new(),
                observed_at: Timestamp::UNIX_EPOCH,
            },
            sync: WalletSync {
                state,
                lag_seconds: None,
                last_tx_at: None,
                indexed_tx: 0,
                import: None,
            },
        }
    }

    fn status(credits_used: u64) -> InstanceStatus {
        InstanceStatus {
            engine: EngineStatus::Running,
            started_at: Timestamp::UNIX_EPOCH,
            chain: ChainTip::default(),
            valuation_interval_seconds: Some(10),
            credits_used,
            credits_budget: 1_000_000,
        }
    }

    #[test]
    fn reports_the_worst_wallet_state() {
        let snapshot = Snapshot::new(SnapshotFacts {
            wallets: vec![wallet(1, SyncState::Live), wallet(2, SyncState::Lagging)],
            ..SnapshotFacts::default()
        })
        .unwrap();
        let now: Timestamp = "2026-10-04T12:00:00Z".parse().unwrap();

        let report = sync_report(&snapshot, &status(0), now).unwrap();

        assert_eq!(report.state, SyncState::Lagging);
        assert_eq!(report.wallets.len(), 2);
    }

    #[test]
    fn is_live_without_any_wallet() {
        let snapshot = Snapshot::new(SnapshotFacts::default()).unwrap();
        let report = sync_report(&snapshot, &status(0), Timestamp::UNIX_EPOCH).unwrap();
        assert_eq!(report.state, SyncState::Live);
    }

    #[test]
    fn projects_the_credits_to_the_end_of_the_month() {
        let snapshot = Snapshot::new(SnapshotFacts::default()).unwrap();
        // The 10th of a 31-day month, 400 000 credits spent: 1 240 000 at this pace.
        let now: Timestamp = "2026-10-10T08:00:00Z".parse().unwrap();

        let credits = sync_report(&snapshot, &status(400_000), now)
            .unwrap()
            .credits;

        assert_eq!((credits.year, credits.month), (2026, 10));
        assert_eq!(credits.projected, 1_240_000);
        assert!(credits.is_over_budget);
        assert_eq!(credits.used_percent.to_decimal_string(), "40");
    }
}
