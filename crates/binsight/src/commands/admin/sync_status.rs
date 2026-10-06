//! `binsight admin sync-status`: how far each wallet is imported, and the credits spent.
//!
//! For each tracked wallet: where its history listing stands, how its transactions stand in the
//! fetch queue and where its repair stands. Then how many transactions could not be decoded, what
//! the registry's facts disagree on (the startup check's reading, made again here without
//! restoring anything), and the credits spent today (UTC, the provider's day), request kind by
//! request kind, against the daily limit, and the current billing cycle's total against the
//! plan. It only reads, so it works while the server runs.

use binsight_core::clock::{Clock, utc_day};
use binsight_engine::portfolio::views::{RegistryFinding, RegistryFindingKind};
use binsight_engine::{SystemClock, read_registry_findings};
use binsight_store::{CreditTotal, FetchCounts, Store, TrackedWallet, WalletCursor, WalletRepair};

use crate::config::Config;
use crate::data_dir::database_path;
use crate::failure::Failure;
use crate::output::print_line;

/// Prints the import of every wallet, then the credits.
pub(super) async fn show_sync_status(config: &Config) -> Result<(), Failure> {
    let store = Store::open_existing(&database_path(&config.data_dir)).await?;
    let wallets = store.wallets().list().await?;
    if wallets.is_empty() {
        print_line("No wallet is tracked; add one with `binsight admin wallet-add <ADDRESS>`.");
    }
    let repairs = store.repairs().list().await?;
    for wallet in &wallets {
        let counts = store.fetch_queue().counts(wallet.address).await?;
        let repair = repairs
            .iter()
            .find(|repair| repair.wallet == wallet.address);
        for line in describe_wallet(wallet, &counts) {
            print_line(&line);
        }
        print_line(&format!("  repair: {}", describe_repair(wallet, repair)));
    }
    let failed = store.decoded().failed_count().await?;
    print_line(&format!("Transactions that could not be decoded: {failed}"));
    for line in describe_findings(&read_registry_findings(&store).await?) {
        print_line(&line);
    }
    let today = utc_day(SystemClock.now());
    let totals = store.credits().totals_between(today, today).await?;
    let budget = config.credit_budget;
    let cycle_start = budget.cycle_day.cycle_start(today);
    let cycle = store.credits().spent_between(cycle_start, today).await?;
    let limit = budget.daily_credit_limit.map_or_else(
        || "no daily limit".to_owned(),
        |limit| format!("daily limit {}", limit.0),
    );
    let spent_today: u64 = totals.iter().map(|total| total.credits.0).sum();
    print_line(&format!(
        "Credits today ({today}, UTC): {spent_today} ({limit})"
    ));
    for total in &totals {
        print_line(&describe_total(total));
    }
    print_line(&format!(
        "Credits this billing cycle (since {cycle_start}, UTC): {} of {}",
        cycle.0, budget.monthly_credits.0
    ));
    Ok(())
}

/// The lines for a wallet: its address, its history listing, its transactions, and what keeps
/// its registry incomplete, if anything.
fn describe_wallet(wallet: &TrackedWallet, counts: &FetchCounts) -> Vec<String> {
    let history = match wallet.cursor {
        WalletCursor::NotStarted if counts.listed == 0 => "not listed yet".to_owned(),
        WalletCursor::NotStarted => "first page listed, its end not confirmed yet".to_owned(),
        WalletCursor::ListingHistory { top, .. } => {
            format!("being listed (newest at slot {})", top.slot)
        }
        WalletCursor::HistoryComplete { top: Some(top) } => {
            format!("fully listed (newest at slot {})", top.slot)
        }
        WalletCursor::HistoryComplete { top: None } => "fully listed (no transaction)".to_owned(),
    };
    let mut lines = vec![
        format!("Wallet {}", wallet.address),
        format!("  history: {history}"),
        format!(
            "  transactions: {} listed, {} fetched, {} pending, {} not returned by the node yet, \
             {} failed, {} of an unsupported version",
            counts.listed,
            counts.fetched,
            counts.pending,
            counts.empty_retry,
            counts.failed,
            counts.unsupported_version
        ),
    ];
    if counts.unsupported_version > 0 {
        lines.push(format!(
            "  incomplete: {} transactions of a version this binsight cannot read; a newer \
             binsight fetches them",
            counts.unsupported_version
        ));
    }
    lines
}

/// Where `wallet`'s repair stands.
fn describe_repair(wallet: &TrackedWallet, repair: Option<&WalletRepair>) -> String {
    let is_listed = matches!(
        wallet.cursor,
        WalletCursor::HistoryComplete { top: Some(_) }
    );
    match repair {
        None if is_listed => {
            "none yet; the first, in full, comes six hours after the wallet was added".to_owned()
        }
        None => "none until its history is listed".to_owned(),
        Some(WalletRepair {
            repaired_at: None, ..
        }) => "a full repair is due".to_owned(),
        Some(WalletRepair {
            repaired_at: Some(at),
            verified: Some(point),
            ..
        }) => format!("last at {at}, verified down to slot {}", point.slot),
        Some(WalletRepair {
            repaired_at: Some(at),
            verified: None,
            ..
        }) => format!("last at {at}, nothing old enough to verify yet"),
    }
}

/// The lines for what the registry's facts disagree on.
fn describe_findings(findings: &[RegistryFinding]) -> Vec<String> {
    if findings.is_empty() {
        return vec!["Registry check: every fact agrees".to_owned()];
    }
    let mut lines = vec!["Registry check:".to_owned()];
    for finding in findings {
        lines.push(format!(
            "  {} {}",
            finding.count,
            describe_finding_kind(finding.kind)
        ));
    }
    lines
}

/// What a kind of finding means, and what binsight does about it.
fn describe_finding_kind(kind: RegistryFindingKind) -> &'static str {
    match kind {
        RegistryFindingKind::WrongListedCounts => {
            "wallets with a wrong count of listed signatures (counted again at the next start)"
        }
        RegistryFindingKind::UnlistedCursorPoints => {
            "wallets whose cursor names a signature they do not list (repaired in full)"
        }
        RegistryFindingKind::UnqueuedSignatures => {
            "listed signatures without a fetch task (queued at the next start)"
        }
        RegistryFindingKind::FetchedWithoutPayload => {
            "transactions marked fetched but missing from the registry (fetched again at the next start)"
        }
        RegistryFindingKind::StoredButQueued => {
            "stored transactions still queued (marked fetched at the next start, never fetched again)"
        }
        RegistryFindingKind::UnreturnedTransactions => {
            "listed transactions the node has not returned yet (tried again)"
        }
        RegistryFindingKind::OutdatedDecodes => {
            "transactions to decode at the current versions (decoded from the registry)"
        }
        RegistryFindingKind::UnorderedTransactions => {
            "transactions without an index in their block (they cannot be ordered exactly)"
        }
    }
}

/// One line for a kind of request.
fn describe_total(total: &CreditTotal) -> String {
    format!(
        "  {} {} for {} ({}): {} requests, {} credits",
        total.priority, total.method, total.purpose, total.outcome, total.calls, total.credits.0
    )
}

#[cfg(test)]
mod tests {
    use binsight_core::credits::{CallOutcome, Credits, Priority, Purpose};
    use binsight_solana::{Address, Signature};
    use binsight_store::ListedTop;
    use jiff::Timestamp;

    use super::*;

    #[test]
    fn describes_a_wallet_being_imported() {
        let wallet = TrackedWallet {
            address: Address::from_bytes([1; 32]),
            added_at: Timestamp::UNIX_EPOCH,
            cursor: WalletCursor::ListingHistory {
                top: ListedTop {
                    signature: Signature::from_bytes([2; 64]),
                    slot: 300,
                },
                before: Signature::from_bytes([3; 64]),
            },
        };
        let counts = FetchCounts {
            listed: 1_000,
            pending: 10,
            fetched: 990,
            ..FetchCounts::default()
        };

        let lines = describe_wallet(&wallet, &counts);

        assert_eq!(lines[1], "  history: being listed (newest at slot 300)");
        assert!(lines[2].starts_with("  transactions: 1000 listed, 990 fetched, 10 pending"));
        assert_eq!(lines.len(), 3);

        let parked = FetchCounts {
            unsupported_version: 2,
            ..counts
        };
        let lines = describe_wallet(&wallet, &parked);
        assert!(lines[3].starts_with("  incomplete: 2 transactions of a version"));
    }

    #[test]
    fn describes_where_a_repair_stands() {
        let top = ListedTop {
            signature: Signature::from_bytes([2; 64]),
            slot: 300,
        };
        let wallet = TrackedWallet {
            address: Address::from_bytes([1; 32]),
            added_at: Timestamp::UNIX_EPOCH,
            cursor: WalletCursor::HistoryComplete { top: Some(top) },
        };
        let repaired = WalletRepair {
            wallet: wallet.address,
            verified: Some(top),
            repaired_at: Some(Timestamp::UNIX_EPOCH),
        };
        let asked = WalletRepair {
            verified: None,
            repaired_at: None,
            ..repaired
        };

        assert!(describe_repair(&wallet, None).starts_with("none yet"));
        assert_eq!(
            describe_repair(&wallet, Some(&repaired)),
            "last at 1970-01-01T00:00:00Z, verified down to slot 300"
        );
        assert_eq!(
            describe_repair(&wallet, Some(&asked)),
            "a full repair is due"
        );
    }

    #[test]
    fn describes_what_the_registry_disagrees_on() {
        let findings = [RegistryFinding {
            kind: RegistryFindingKind::UnqueuedSignatures,
            count: 3,
        }];

        assert_eq!(
            describe_findings(&[]),
            ["Registry check: every fact agrees"]
        );
        assert_eq!(
            describe_findings(&findings),
            [
                "Registry check:",
                "  3 listed signatures without a fetch task (queued at the next start)"
            ]
        );
    }

    #[test]
    fn describes_a_kind_of_request() {
        let total = CreditTotal {
            method: "getTransaction".to_owned(),
            priority: Priority::History,
            purpose: Purpose::TransactionFetch,
            outcome: CallOutcome::Ok,
            calls: 312,
            credits: Credits(312),
        };

        assert_eq!(
            describe_total(&total),
            "  history getTransaction for transaction_fetch (ok): 312 requests, 312 credits"
        );
    }
}
