//! The synchronization report: the worst wallet state, the chain tip and the cycle's credits.

use binsight_core::error::AmountError;
use binsight_core::ratio::Percent;
use binsight_ledger::report::figure::{Figure, Reason};
use jiff::Timestamp;

use crate::portfolio::instance_status::InstanceStatus;
use crate::portfolio::read_error::ReadError;
use crate::portfolio::snapshot::Snapshot;
use crate::portfolio::views::{CreditsSummary, SyncReport, SyncState, WalletRef, WalletSyncLine};

/// The synchronization of the instance at `now`.
///
/// # Errors
///
/// Returns an error when the supplied cycle is invalid or a projection overflows.
/// A zero budget makes only its percentage unavailable.
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
    report_of(wallets, status, now)
}

/// The synchronization of the instance at `now`, from each wallet's line and the instance's
/// status: one rule for every source.
///
/// # Errors
///
/// Returns an error when the supplied cycle is invalid or a projection overflows.
pub(crate) fn report_of(
    wallets: Vec<WalletSyncLine>,
    status: &InstanceStatus,
    now: Timestamp,
) -> Result<SyncReport, ReadError> {
    Ok(SyncReport {
        state: SyncState::worst(wallets.iter().map(|line| line.sync.state)),
        engine: status.engine,
        as_of: now,
        started_at: status.started_at,
        chain: status.chain,
        valuation_interval_seconds: status.valuation_interval_seconds,
        credits: credits(status, now)?,
        failed_decodes: status.failed_decodes,
        registry_check: status.registry_check.clone(),
        wallets,
    })
}

/// Credits of the supplied billing cycle, projected by elapsed UTC seconds.
pub(super) fn credits(
    status: &InstanceStatus,
    now: Timestamp,
) -> Result<CreditsSummary, ReadError> {
    let cycle = status.credit_cycle;
    let duration_seconds = cycle
        .end
        .as_second()
        .checked_sub(cycle.start.as_second())
        .filter(|seconds| *seconds > 0)
        .ok_or(ReadError::MissingFact)?;
    let elapsed_seconds = now
        .as_second()
        .checked_sub(cycle.start.as_second())
        .ok_or(AmountError::Overflow)?;
    let projected = if elapsed_seconds <= 0 {
        None
    } else {
        let duration = u128::try_from(duration_seconds).map_err(|_| ReadError::MissingFact)?;
        let elapsed = u128::try_from(elapsed_seconds.min(duration_seconds))
            .map_err(|_| ReadError::MissingFact)?;
        let projection = u128::from(status.credits_used)
            .checked_mul(duration)
            .and_then(|product| product.checked_div(elapsed))
            .ok_or(AmountError::Overflow)?;
        Some(u64::try_from(projection).map_err(|_| AmountError::Overflow)?)
    };
    let used_percent = if status.credits_budget == 0 {
        Figure::unavailable(Reason::ZeroDenominator)
    } else {
        Figure::Complete(Percent::of(
            i128::from(status.credits_used),
            i128::from(status.credits_budget),
        )?)
    };
    Ok(CreditsSummary {
        cycle,
        used: status.credits_used,
        budget: status.credits_budget,
        used_percent,
        projected,
        is_over_budget: if status.credits_used > status.credits_budget {
            Some(true)
        } else {
            projected.map(|projected| projected > status.credits_budget)
        },
    })
}

#[cfg(test)]
mod tests {
    use binsight_core::units::Lamports;
    use binsight_ledger::facts::{HistoryCoverage, WalletFacts, WalletHoldings};
    use binsight_solana::Address;

    use super::*;
    use crate::engine::status::EngineStatus;
    use crate::portfolio::snapshot::{SnapshotFacts, TrackedWallet};
    use crate::portfolio::views::{ChainTip, WalletColor, WalletSync};
    use crate::portfolio::wallet_label::WalletLabel;

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
            credit_cycle: crate::portfolio::views::BillingCycle {
                start: "2026-09-17T00:00:00Z".parse().unwrap(),
                end: "2026-10-17T00:00:00Z".parse().unwrap(),
            },
            credits_used,
            credits_budget: 1_000_000,
            failed_decodes: 0,
            registry_check: None,
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
    fn projects_the_credits_on_elapsed_seconds_of_the_supplied_cycle() {
        let snapshot = Snapshot::new(SnapshotFacts::default()).unwrap();
        // Halfway through the supplied cycle, 400 000 spent projects to 800 000.
        let now: Timestamp = "2026-10-02T00:00:00Z".parse().unwrap();

        let credits = sync_report(&snapshot, &status(400_000), now)
            .unwrap()
            .credits;

        assert_eq!(credits.projected, Some(800_000));
        assert_eq!(credits.is_over_budget, Some(false));
        assert_eq!(
            credits.used_percent.value().unwrap().to_decimal_string(),
            "40"
        );
    }

    #[test]
    fn leaves_projection_unknown_at_reset_without_hiding_an_observed_excess() {
        let at_reset = status(0).credit_cycle.start;
        let empty = credits(&status(0), at_reset).unwrap();
        assert_eq!(empty.projected, None);
        assert_eq!(empty.is_over_budget, None);
        let exceeded = credits(&status(1_000_001), at_reset).unwrap();
        assert_eq!(exceeded.projected, None);
        assert_eq!(exceeded.is_over_budget, Some(true));
    }

    #[test]
    fn keeps_credit_counts_available_with_a_zero_budget() {
        let mut source = status(42);
        source.credits_budget = 0;
        let now = source
            .credit_cycle
            .start
            .checked_add(jiff::SignedDuration::from_secs(3_600))
            .unwrap();
        let result = credits(&source, now).unwrap();
        assert_eq!(result.used, 42);
        assert_eq!(
            result.used_percent,
            Figure::unavailable(Reason::ZeroDenominator)
        );
        assert_eq!(result.is_over_budget, Some(true));
    }

    #[test]
    fn uses_the_elapsed_fraction_of_the_first_day_without_counting_a_whole_day() {
        let source = status(1_000);
        let now = source
            .credit_cycle
            .start
            .checked_add(jiff::SignedDuration::from_secs(43_200))
            .unwrap();
        let result = credits(&source, now).unwrap();
        assert_eq!(result.projected, Some(60_000));
        assert_eq!(result.is_over_budget, Some(false));
    }

    #[test]
    fn refuses_projection_overflow_instead_of_saturating_the_credit_count() {
        let source = status(u64::MAX);
        let now = source
            .credit_cycle
            .start
            .checked_add(jiff::SignedDuration::from_secs(1))
            .unwrap();
        assert!(matches!(credits(&source, now), Err(ReadError::Rule(_))));
    }
}
