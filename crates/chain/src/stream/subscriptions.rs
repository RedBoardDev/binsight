//! Which wallets are watched, and where each one's subscription stands on the current connection.
//!
//! A wallet is watched until the engine unwatches it; on each connection it is subscribed once
//! (a second subscription would double every notification). A subscribe request is pending until
//! the server answers with a subscription id or an error; a refused wallet is asked again after
//! a delay, on whatever connection is open then. A subscription confirmed for a wallet that was
//! unwatched meanwhile is released at once rather than leaked. Every connection starts with no
//! subscription. This module is pure bookkeeping: it hands out the requests to send and never
//! sends them.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

use binsight_solana::Address;
use tokio::time::Instant;

/// How long a refused subscription waits before it is asked again.
pub(super) const ACK_TIMEOUT: Duration = Duration::from_secs(15);

/// How long an explicit refusal holds its wallet back.
const REFUSED_RETRY_DELAY: Duration = Duration::from_mins(5);

/// What a subscription answer means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Confirmation {
    /// The wallet is now subscribed.
    Subscribed(Address),
    /// Nobody watches the wallet any more: release this subscription.
    Release(u64),
    /// The answer matches no subscribe request (an unsubscribe's answer, or a stale one).
    Unrelated,
}

/// The watched wallets and their subscriptions on the current connection.
#[derive(Debug, Default)]
pub(crate) struct Subscriptions {
    watched: BTreeSet<Address>,
    /// Subscribe requests waiting for their answer, by request id.
    pending: HashMap<u64, (Address, Instant)>,
    /// Confirmed subscriptions, by subscription id.
    active: HashMap<u64, Address>,
    /// Refused wallets, and when to ask again.
    refused: BTreeMap<Address, Instant>,
    next_request_id: u64,
}

impl Subscriptions {
    /// Whether no wallet is watched.
    pub(crate) fn is_empty(&self) -> bool {
        self.watched.is_empty()
    }

    /// Starts watching `wallet`; returns whether it was not watched yet.
    pub(crate) fn watch(&mut self, wallet: Address) -> bool {
        self.watched.insert(wallet)
    }

    /// Stops watching `wallet`; returns its subscription to release, if it had one.
    pub(crate) fn unwatch(&mut self, wallet: Address) -> Option<u64> {
        self.watched.remove(&wallet);
        self.refused.remove(&wallet);
        let subscription = self
            .active
            .iter()
            .find(|(_, subscribed)| **subscribed == wallet)
            .map(|(subscription, _)| *subscription)?;
        self.active.remove(&subscription);
        Some(subscription)
    }

    /// The subscribe requests to send at `now`: every watched wallet neither subscribed, nor
    /// waiting for an answer, nor waiting to be asked again. Each gets a new request id.
    pub(crate) fn requests_due(&mut self, now: Instant) -> Vec<(u64, Address)> {
        self.refused.retain(|_, retry_at| *retry_at > now);
        let due: Vec<Address> = self
            .watched
            .iter()
            .filter(|wallet| {
                !self.refused.contains_key(*wallet)
                    && !self.pending.values().any(|(pending, _)| pending == *wallet)
                    && !self.active.values().any(|active| active == *wallet)
            })
            .copied()
            .collect();
        due.into_iter()
            .map(|wallet| {
                let request_id = self.new_request_id();
                self.pending.insert(
                    request_id,
                    (wallet, now.checked_add(ACK_TIMEOUT).unwrap_or(now)),
                );
                (request_id, wallet)
            })
            .collect()
    }

    /// A new request id, for a request this bookkeeping does not follow (an unsubscribe).
    pub(crate) fn new_request_id(&mut self) -> u64 {
        self.next_request_id = self.next_request_id.wrapping_add(1);
        self.next_request_id
    }

    /// The server answered `request_id` with `subscription`.
    pub(crate) fn confirmed(&mut self, request_id: u64, subscription: u64) -> Confirmation {
        let Some((wallet, _)) = self.pending.remove(&request_id) else {
            return Confirmation::Unrelated;
        };
        if !self.watched.contains(&wallet) {
            return Confirmation::Release(subscription);
        }
        self.active.insert(subscription, wallet);
        Confirmation::Subscribed(wallet)
    }

    /// The server refused `request_id` at `now`; returns the wallet it was for, which is asked
    /// again later, if it was a subscribe request.
    pub(crate) fn refused(&mut self, request_id: u64, now: Instant) -> Option<Address> {
        let (wallet, _) = self.pending.remove(&request_id)?;
        let retry_at = now.checked_add(REFUSED_RETRY_DELAY).unwrap_or(now);
        if self.watched.contains(&wallet) {
            self.refused.insert(wallet, retry_at);
        }
        Some(wallet)
    }

    /// The wallet `subscription` watches, if it is one of ours.
    pub(crate) fn wallet_of(&self, subscription: u64) -> Option<Address> {
        self.active.get(&subscription).copied()
    }

    /// When the next refused wallet may be asked again.
    pub(crate) fn next_retry_at(&self) -> Option<Instant> {
        self.refused
            .values()
            .copied()
            .chain(self.next_ack_at())
            .min()
    }

    /// The earliest pending acknowledgement for a wallet still watched.
    pub(crate) fn next_ack_at(&self) -> Option<Instant> {
        self.pending
            .values()
            .filter(|(wallet, _)| self.watched.contains(wallet))
            .map(|(_, deadline)| *deadline)
            .min()
    }

    /// A wallet whose subscription was never acknowledged; reconnect before retrying so a
    /// late acknowledgement cannot leave duplicate server subscriptions.
    pub(crate) fn unanswered(&self, now: Instant) -> Option<Address> {
        self.pending
            .values()
            .filter(|(wallet, deadline)| self.watched.contains(wallet) && *deadline <= now)
            .min_by_key(|(_, deadline)| *deadline)
            .map(|(wallet, _)| *wallet)
    }

    /// The connection ended: no subscription survives it.
    pub(crate) fn disconnected(&mut self) {
        self.pending.clear();
        self.active.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WALLET: Address = Address::from_bytes([1; 32]);
    const OTHER: Address = Address::from_bytes([2; 32]);

    #[test]
    fn subscribes_each_watched_wallet_once_per_connection() {
        let mut subscriptions = Subscriptions::default();
        subscriptions.watch(WALLET);
        subscriptions.watch(OTHER);
        let now = Instant::now();

        let requests = subscriptions.requests_due(now);

        assert_eq!(requests.len(), 2);
        assert_eq!(subscriptions.requests_due(now), Vec::new());
        subscriptions.disconnected();
        assert_eq!(subscriptions.requests_due(now).len(), 2);
    }

    #[test]
    fn routes_a_notification_to_the_confirmed_wallet() {
        let mut subscriptions = Subscriptions::default();
        subscriptions.watch(WALLET);
        let [(request_id, _)] = subscriptions.requests_due(Instant::now())[..] else {
            panic!("one request expected");
        };

        let confirmation = subscriptions.confirmed(request_id, 77);

        assert_eq!(confirmation, Confirmation::Subscribed(WALLET));
        assert_eq!(subscriptions.wallet_of(77), Some(WALLET));
        assert_eq!(subscriptions.wallet_of(78), None);
    }

    #[test]
    fn releases_a_subscription_confirmed_after_unwatch() {
        let mut subscriptions = Subscriptions::default();
        subscriptions.watch(WALLET);
        let [(request_id, _)] = subscriptions.requests_due(Instant::now())[..] else {
            panic!("one request expected");
        };

        assert_eq!(subscriptions.unwatch(WALLET), None);

        assert_eq!(
            subscriptions.confirmed(request_id, 77),
            Confirmation::Release(77)
        );
        assert_eq!(subscriptions.wallet_of(77), None);
    }

    #[test]
    fn asks_a_refused_wallet_again_five_minutes_later() {
        let mut subscriptions = Subscriptions::default();
        subscriptions.watch(WALLET);
        let now = Instant::now();
        let [(request_id, _)] = subscriptions.requests_due(now)[..] else {
            panic!("one request expected");
        };

        assert_eq!(subscriptions.refused(request_id, now), Some(WALLET));

        let five_minutes = now.checked_add(REFUSED_RETRY_DELAY).unwrap();
        assert_eq!(subscriptions.requests_due(now), Vec::new());
        assert_eq!(subscriptions.next_retry_at(), Some(five_minutes));
        assert_eq!(subscriptions.requests_due(five_minutes).len(), 1);
    }

    #[test]
    fn ignores_an_unwatched_pending_ack_deadline_but_releases_its_late_ack() {
        let mut subscriptions = Subscriptions::default();
        subscriptions.watch(WALLET);
        let now = Instant::now();
        let request = subscriptions.requests_due(now)[0].0;
        subscriptions.unwatch(WALLET);
        assert_eq!(subscriptions.next_retry_at(), None);
        assert_eq!(subscriptions.unanswered(now + ACK_TIMEOUT), None);
        assert_eq!(
            subscriptions.confirmed(request, 77),
            Confirmation::Release(77)
        );
    }

    #[test]
    fn gives_back_the_subscription_of_an_unwatched_wallet() {
        let mut subscriptions = Subscriptions::default();
        subscriptions.watch(WALLET);
        let [(request_id, _)] = subscriptions.requests_due(Instant::now())[..] else {
            panic!("one request expected");
        };
        subscriptions.confirmed(request_id, 77);

        assert_eq!(subscriptions.unwatch(WALLET), Some(77));
        assert!(subscriptions.is_empty());
    }
}
