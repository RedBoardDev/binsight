//! The daily comparison of the wallets' token accounts with the chain, and what it lists.
//!
//! A token transfer to a wallet's existing token account names the account, not the wallet, so
//! no listing of the wallet finds it. Once a day (the first time ten minutes after startup), the
//! worker reads on chain every token account a live wallet owns (one credit per hundred accounts,
//! at the history priority) and compares each with what the registry last saw of it
//! (`balance_rules`). A disagreement that still holds two minutes later, while the registry did
//! not move, has its account listed down to the registry's last transaction of it
//! (`account_listing`), which fills the gap. One that a listing does not explain is reported once
//! and not listed again until the registry or the chain changes. Without a token account to
//! compare, nothing is sent. Wallets still importing or behind are left out: their registry is
//! not complete yet.

mod account_listing;
mod account_reads;
mod balance_rules;

use std::collections::HashSet;

use binsight_solana::Address;
use binsight_store::TokenAccountBalance;
use jiff::{SignedDuration, Timestamp};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use super::Ingestion;
use super::listing::PageError;
use super::refusal::{report_pause, time_until};
use crate::portfolio::views::SyncState;
use account_listing::list_token_account;
use account_reads::read_amounts;
use balance_rules::{
    CHECK_INTERVAL, DisagreementKey, FIRST_CHECK_DELAY, OnChain, RECHECK_DELAY, disagrees,
    is_unchanged, key_of,
};

/// How long a comparison that failed waits before the next attempt.
const FAILED_CHECK_RETRY: SignedDuration = SignedDuration::from_hours(1);

/// A token account and what the chain held in it.
type Suspect = (TokenAccountBalance, OnChain);

/// Compares the token accounts with the chain once a day until `shutdown` is cancelled.
pub(super) async fn run_balance_check(ingestion: &Ingestion, shutdown: &CancellationToken) {
    let mut next_check = later(ingestion.clock.now(), FIRST_CHECK_DELAY);
    let mut unexplained = HashSet::new();
    loop {
        let wait = time_until(ingestion.clock.now(), next_check);
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = tokio::time::sleep(wait) => {}
        }
        let checked = check_once(ingestion, &mut unexplained, shutdown).await;
        let now = ingestion.clock.now();
        next_check = match checked {
            Ok(()) => later(now, CHECK_INTERVAL),
            Err(PageError::Deferred { until }) => until,
            Err(PageError::Paused { until, reason }) => {
                report_pause(ingestion, "balance check", &reason, until);
                until
            }
            Err(error) => {
                warn!(%error, "could not compare the token accounts with the chain; trying again later");
                later(now, FAILED_CHECK_RETRY)
            }
        };
    }
}

/// Compares every live wallet's token accounts with the chain once, and lists the accounts
/// whose disagreement holds.
async fn check_once(
    ingestion: &Ingestion,
    unexplained: &mut HashSet<DisagreementKey>,
    shutdown: &CancellationToken,
) -> Result<(), PageError> {
    let suspects = suspects(ingestion, live_accounts(ingestion).await?).await?;
    debug!(
        suspects = suspects.len(),
        "token accounts compared with the chain"
    );
    if suspects.is_empty() {
        return Ok(());
    }
    let recheck = std::time::Duration::try_from(RECHECK_DELAY).unwrap_or_default();
    tokio::select! {
        () = shutdown.cancelled() => return Ok(()),
        () = tokio::time::sleep(recheck) => {}
    }
    for (known, on_chain) in confirm(ingestion, &suspects).await? {
        let key = key_of(&known, &on_chain);
        if unexplained.contains(&key) {
            continue;
        }
        let found = list_token_account(ingestion, &known).await?;
        let (wallet, account) = (known.wallet, known.token_account);
        if found.missing == 0 && found.brought_forward == 0 {
            warn!(%wallet, %account, "a token account disagrees with the registry, and listing it found nothing new");
            unexplained.insert(key);
        } else {
            warn!(%wallet, %account, missing = found.missing,
                "a token account disagreed with the registry; the transactions it missed are fetched");
        }
    }
    Ok(())
}

/// Which of `known` disagree with the chain.
async fn suspects(
    ingestion: &Ingestion,
    known: Vec<TokenAccountBalance>,
) -> Result<Vec<Suspect>, PageError> {
    if known.is_empty() {
        return Ok(Vec::new());
    }
    let accounts: Vec<Address> = known.iter().map(|known| known.token_account).collect();
    let on_chain = read_amounts(ingestion, &accounts).await?;
    Ok(known
        .into_iter()
        .zip(on_chain)
        .filter(|(known, on_chain)| disagrees(known, on_chain))
        .collect())
}

/// The `suspects` the registry still sees as it did and the chain still disagrees with.
async fn confirm(ingestion: &Ingestion, suspects: &[Suspect]) -> Result<Vec<Suspect>, PageError> {
    let now_known = live_accounts(ingestion).await?;
    let unchanged: Vec<TokenAccountBalance> = suspects
        .iter()
        .filter_map(|(before, _)| {
            now_known
                .iter()
                .find(|now| {
                    now.wallet == before.wallet && now.token_account == before.token_account
                })
                .filter(|now| is_unchanged(before, now))
                .copied()
        })
        .collect();
    self::suspects(ingestion, unchanged).await
}

/// The token accounts the live wallets own, as the registry last saw them.
async fn live_accounts(ingestion: &Ingestion) -> Result<Vec<TokenAccountBalance>, PageError> {
    let live: HashSet<Address> = ingestion
        .sync
        .statuses
        .borrow()
        .iter()
        .flat_map(|statuses| statuses.iter())
        .filter(|status| status.state == SyncState::Live)
        .map(|status| status.progress.wallet.address)
        .collect();
    if live.is_empty() {
        return Ok(Vec::new());
    }
    let owned = ingestion.store.token_accounts().owned().await?;
    Ok(owned
        .into_iter()
        .filter(|account| live.contains(&account.wallet))
        .collect())
}

/// `instant` plus `delay`, or the end of time.
fn later(instant: Timestamp, delay: SignedDuration) -> Timestamp {
    instant.checked_add(delay).unwrap_or(Timestamp::MAX)
}

#[cfg(test)]
mod tests;
