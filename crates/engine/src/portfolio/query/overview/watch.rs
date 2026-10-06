//! What deserves the owner's attention, most urgent first: positions out of range, tokens
//! without a price, wallets importing or lagging, and a billing cycle that will exceed its credits.

use binsight_ledger::report::open::RangeStatus;
use jiff::Timestamp;

use crate::portfolio::instance_status::InstanceStatus;
use crate::portfolio::query::refs::{pool_ref, wallet_ref};
use crate::portfolio::query::sync::credits;
use crate::portfolio::read_error::ReadError;
use crate::portfolio::scope::Scope;
use crate::portfolio::snapshot::Snapshot;
use crate::portfolio::views::{SyncState, UnpricedHolding, WatchItem};

/// The watch list of `scope`.
pub(super) fn watch_items(
    snapshot: &Snapshot,
    status: &InstanceStatus,
    scope: Scope,
    unpriced: &[UnpricedHolding],
    now: Timestamp,
) -> Result<Vec<WatchItem>, ReadError> {
    let mut out_of_range: Vec<_> = snapshot
        .open_in(scope)
        .filter(|row| row.valuation.range != RangeStatus::InRange)
        .collect();
    out_of_range.sort_by_key(|row| (row.facts.range_since, row.facts.id));
    let mut items = out_of_range
        .into_iter()
        .map(|row| {
            Ok(WatchItem::OutOfRange {
                position: row.facts.id,
                pool: Box::new(pool_ref(snapshot, row.facts.pool)?),
                wallet: wallet_ref(snapshot, row.facts.wallet)?,
                is_above: row.valuation.range == RangeStatus::Above,
                since: row.facts.range_since,
            })
        })
        .collect::<Result<Vec<_>, ReadError>>()?;
    items.extend(unpriced.iter().cloned().map(WatchItem::UnpricedToken));
    for wallet in snapshot.wallets_in(scope) {
        let wallet_ref = wallet_ref(snapshot, wallet.facts.address)?;
        if let Some(import) = wallet.sync.import {
            items.push(WatchItem::Importing {
                wallet: wallet_ref,
                progress: import.progress,
                eta_seconds: import.eta_seconds,
            });
        } else if wallet.sync.state == SyncState::Lagging {
            items.push(WatchItem::Lagging {
                wallet: wallet_ref,
                lag_seconds: wallet.sync.lag_seconds,
            });
        }
    }
    let credits = credits(status, now)?;
    if credits.is_over_budget == Some(true) {
        items.push(WatchItem::CreditsOverBudget {
            used: credits.used,
            projected: credits.projected,
            budget: credits.budget,
        });
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EngineStatus;
    use crate::portfolio::SnapshotFacts;
    use crate::portfolio::views::{BillingCycle, ChainTip};

    #[test]
    fn keeps_an_observed_credit_excess_visible_at_reset_without_a_projection() {
        let start: Timestamp = "2026-09-17T00:00:00Z".parse().unwrap();
        let status = InstanceStatus {
            engine: EngineStatus::Running,
            started_at: start,
            chain: ChainTip::default(),
            valuation_interval_seconds: None,
            credit_cycle: BillingCycle {
                start,
                end: "2026-10-17T00:00:00Z".parse().unwrap(),
            },
            credits_used: 101,
            credits_budget: 100,
            failed_decodes: 0,
        };
        let snapshot = Snapshot::new(SnapshotFacts::default()).unwrap();
        let items = watch_items(&snapshot, &status, Scope::All, &[], start).unwrap();
        assert_eq!(
            items,
            vec![WatchItem::CreditsOverBudget {
                used: 101,
                projected: None,
                budget: 100,
            }]
        );
    }
}
