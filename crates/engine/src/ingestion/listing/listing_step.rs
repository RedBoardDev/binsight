//! One step of the listing worker: the most urgent listing that is due, run.
//!
//! Before anything, the tracked wallets are watched by the stream, and at startup the worker
//! waits for their subscriptions (a short grace at most): listing first and subscribing after
//! would leave a gap neither sees. Then checks go first (`live`), then history pages
//! (`history_schedule`), each only if the credit budget lets its class go. A listing that fails
//! holds its wallet back with a growing delay while the others go on; a class the budget defers
//! waits until its deferral ends; a refusal that concerns every request pauses the worker.

use std::collections::{BTreeMap, VecDeque};
use std::time::Duration;

use binsight_chain::SignaturesRequest;
use binsight_core::credits::Priority;
use binsight_solana::Address;
use binsight_store::TrackedWallet;
use jiff::Timestamp;
use tracing::{debug, error, warn};

use super::history_page::list_and_write;
use super::history_schedule::{ListingSchedule, NextListing};
use super::page_listing::PageError;
use super::top_up::TopUp;
use crate::ingestion::live::{CheckReason, NextCheck};
use crate::ingestion::refusal::{ClassDeferrals, report_pause, time_until};
use crate::ingestion::{Ingestion, STORE_RETRY_DELAY};

/// From this many failures in a row, a wallet's failing listing is reported as an error: it is
/// not healing by itself, and a human should look.
const FAILURES_BEFORE_ALERT: u32 = 5;

/// The class history pages are listed at.
const HISTORY_CLASS: Priority = Priority::CatchUp;

/// How a step ended.
pub(super) enum Progress {
    /// Look for the next listing at once.
    Continue,
    /// Nothing is due: look again after this delay (`None`: only when something changes).
    Wait(Option<Duration>),
}

/// What the worker remembers between steps.
#[derive(Debug, Default)]
pub(super) struct ListingWorker {
    history: ListingSchedule,
    deferrals: ClassDeferrals,
    top_ups: BTreeMap<Address, TopUp>,
    pending_pages: VecDeque<Address>,
    paused_until: Option<Timestamp>,
}

impl ListingWorker {
    /// Runs the most urgent listing due, or says how long nothing is.
    pub(super) async fn step(&mut self, ingestion: &Ingestion) -> Progress {
        let wallets = match ingestion.store.wallets().list().await {
            Ok(wallets) => wallets,
            Err(error) => {
                error!(%error, "could not read the tracked wallets");
                return Progress::Wait(Some(STORE_RETRY_DELAY));
            }
        };
        ingestion.watch_new_wallets(&wallets);
        let now = ingestion.clock.now();
        self.top_ups
            .retain(|address, _| wallets.iter().any(|wallet| wallet.address == *address));
        self.pending_pages
            .retain(|address| self.top_ups.contains_key(address));
        if let Some(until) = self.paused_until.filter(|until| *until > now) {
            return Progress::Wait(Some(time_until(now, until)));
        }
        self.paused_until = None;
        let live = &ingestion.live;
        if !live.is_startup_settled(&wallets, now) {
            return Progress::Wait(Some(time_until(now, live.startup_grace_end())));
        }
        let mut wake_at = self.deferrals.next_end(now);
        let least_urgent = self.deferrals.least_urgent_allowed(now);
        if let Some(least_urgent) = least_urgent {
            let unchecked: Vec<_> = wallets
                .iter()
                .filter(|wallet| !self.top_ups.contains_key(&wallet.address))
                .copied()
                .collect();
            match live.next_check(&unchecked, least_urgent, now) {
                NextCheck::Check { wallet, reason } => {
                    return self.check(ingestion, &wallets, wallet, reason).await;
                }
                NextCheck::WaitUntil(at) => wake_at = Some(earliest(wake_at, at)),
                NextCheck::Nothing => {}
            }
        }
        if let Some(allowed) = least_urgent {
            let count = self.pending_pages.len();
            for _ in 0..count {
                let Some(wallet) = self.pending_pages.pop_front() else {
                    break;
                };
                if let Some(top_up) = self.top_ups.get(&wallet) {
                    if let Some(retry_at) = top_up.retry_at.filter(|retry_at| *retry_at > now) {
                        wake_at = Some(earliest(wake_at, retry_at));
                    } else if top_up.reason.priority() <= allowed {
                        return self.advance_top_up(ingestion, wallet).await;
                    }
                }
                self.pending_pages.push_back(wallet);
            }
        }
        if least_urgent.is_some_and(|least_urgent| HISTORY_CLASS <= least_urgent) {
            match self.history.next(&wallets, now, |address| {
                !self.top_ups.contains_key(&address)
            }) {
                NextListing::List { wallet, request } => {
                    return self.history_page(ingestion, wallet, request).await;
                }
                NextListing::WaitUntil(at) => wake_at = Some(earliest(wake_at, at)),
                NextListing::Nothing => {}
            }
        }
        Progress::Wait(wake_at.map(|at| time_until(now, at)))
    }

    /// Lists `wallet` again from its newest signature, for `reason`.
    async fn check(
        &mut self,
        ingestion: &Ingestion,
        wallets: &[TrackedWallet],
        wallet: Address,
        reason: CheckReason,
    ) -> Progress {
        let Some(tracked) = wallets.iter().find(|tracked| tracked.address == wallet) else {
            return Progress::Continue;
        };
        self.top_ups
            .insert(wallet, TopUp::new(tracked, reason, ingestion.clock.now()));
        self.advance_top_up(ingestion, wallet).await
    }

    async fn advance_top_up(&mut self, ingestion: &Ingestion, wallet: Address) -> Progress {
        let Some(top_up) = self.top_ups.get_mut(&wallet) else {
            return Progress::Continue;
        };
        let reason = top_up.reason;
        match top_up.advance(ingestion, wallet).await {
            Ok(Some(started_at)) => {
                self.top_ups.remove(&wallet);
                ingestion.live.checked(wallet, started_at);
                Progress::Continue
            }
            Ok(None) => {
                self.pending_pages.push_back(wallet);
                Progress::Continue
            }
            Err(error) => {
                let retry = |now| ingestion.live.check_failed(wallet, now);
                let failure = setback_failure(ingestion, wallet, error, retry);
                if let Setback::RetryLater(at) = failure
                    && let Some(top_up) = self.top_ups.get_mut(&wallet)
                {
                    top_up.retry_at = Some(at);
                }
                self.pending_pages.push_back(wallet);
                self.apply(ingestion, reason.priority(), &failure)
            }
        }
    }

    /// Lists and writes one history page of `wallet`. The first page lists from the newest
    /// signature, so it is a check too.
    async fn history_page(
        &mut self,
        ingestion: &Ingestion,
        wallet: &TrackedWallet,
        request: SignaturesRequest,
    ) -> Progress {
        let started_at = ingestion.clock.now();
        let unconfirmed_end = self.history.unconfirmed_end(wallet.address).cloned();
        match list_and_write(ingestion, wallet, request, unconfirmed_end.as_ref()).await {
            Ok(end) => {
                if request.before.is_none() {
                    ingestion.live.checked(wallet.address, started_at);
                }
                let now = ingestion.clock.now();
                self.history.record_page(wallet.address, end, now);
                Progress::Continue
            }
            Err(error) => {
                let history = &mut self.history;
                let retry = |now| history.record_failure(wallet.address, now);
                let failure = setback_failure(ingestion, wallet.address, error, retry);
                self.apply(ingestion, HISTORY_CLASS, &failure)
            }
        }
    }

    /// Applies what a failed listing of `class` asks for.
    fn apply(&mut self, ingestion: &Ingestion, class: Priority, failure: &Setback) -> Progress {
        match *failure {
            Setback::Defer(until) => {
                debug!(%class, %until, "listing deferred by the credit budget");
                self.deferrals.defer(class, until);
                Progress::Continue
            }
            Setback::Pause(until) => {
                self.paused_until = Some(until);
                Progress::Wait(Some(time_until(ingestion.clock.now(), until)))
            }
            Setback::RetryLater(_) => Progress::Continue,
        }
    }
}

/// What a failed listing asks for.
#[derive(Debug, Clone, Copy)]
enum Setback {
    /// Hold its class back until then.
    Defer(Timestamp),
    /// Pause every listing until then.
    Pause(Timestamp),
    /// Its wallet was held back; go on with the others.
    RetryLater(Timestamp),
}

/// Reads `error`, and holds `wallet` back through `retry` when the failure is its own.
fn setback_failure(
    ingestion: &Ingestion,
    wallet: Address,
    error: PageError,
    retry: impl FnOnce(Timestamp) -> (u32, Timestamp),
) -> Setback {
    match error {
        PageError::Deferred { until } => Setback::Defer(until),
        PageError::Paused { until, reason } => {
            report_pause(ingestion, "listing", &reason, until);
            Setback::Pause(until)
        }
        error @ (PageError::Rpc(_) | PageError::Store(_)) => {
            let (failures, retry_at) = retry(ingestion.clock.now());
            if failures >= FAILURES_BEFORE_ALERT {
                error!(%wallet, %error, failures, %retry_at, "a listing keeps failing");
            } else {
                warn!(%wallet, %error, failures, %retry_at, "could not list a page; trying again later");
            }
            Setback::RetryLater(retry_at)
        }
    }
}

/// The earlier of `current` and `candidate`.
fn earliest(current: Option<Timestamp>, candidate: Timestamp) -> Timestamp {
    current.map_or(candidate, |current| current.min(candidate))
}

#[cfg(test)]
#[path = "tests/top_up_recovery.rs"]
mod tests;
