//! `binsight admin sync-status`: how far each wallet is imported, and the credits spent.
//!
//! For each tracked wallet: where its history listing stands and how its transactions stand in
//! the fetch queue. Then the credits spent today (UTC, the provider's day), request kind by
//! request kind, against the daily limit, and this calendar month's total against the plan (the
//! provider's billing cycle may start on another day). It only reads, so it works while the
//! server runs.

use binsight_core::clock::{Clock, utc_day};
use binsight_engine::SystemClock;
use binsight_store::{CreditTotal, FetchCounts, Store, TrackedWallet, WalletCursor};

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
    for wallet in &wallets {
        let counts = store.fetch_queue().counts(wallet.address).await?;
        for line in describe_wallet(wallet, &counts) {
            print_line(&line);
        }
    }
    let today = utc_day(SystemClock.now());
    let totals = store.credits().totals_between(today, today).await?;
    let month = store
        .credits()
        .spent_between(today.first_of_month(), today)
        .await?;
    let budget = config.credit_budget;
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
        "Credits this calendar month (since {}, UTC): {} of {}",
        today.first_of_month(),
        month.0,
        budget.monthly_credits.0
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
