//! A wallet's entries outside its positions: transaction costs, trading, airdrops, capital moves.
//!
//! Every position pays a base fee and a priority fee when it opens and when it closes; a few pay a
//! tip, fail a transaction or lose rent. Some wallets trade outside positions (the busy one loses
//! at it) and the busy one buys a token that has no price. Top-up deposits are added later, once
//! the cash flows are known (see `sweep`).

use binsight_core::money::SignedLamports;
use binsight_ledger::facts::{
    ClosedPositionFacts, OpenPositionFacts, WalletEntry, WalletEntryKind,
};
use binsight_solana::Address;
use jiff::{SignedDuration, Timestamp};

use super::Timeline;
use crate::addresses::signature;
use crate::random::Stream;
use crate::scenario::{SOL, UNPRICED_TOKEN_COST_LAMPORTS, WalletProfile};

/// The base fee of a transaction, in lamports.
const NETWORK_FEE_LAMPORTS: i128 = 5_000;

/// The smallest and largest priority fees, in lamports.
const PRIORITY_FEE_LAMPORTS: (i64, i64) = (10_000, 200_000);

/// The smallest and largest tips, in lamports.
const TIP_LAMPORTS: (i64, i64) = (100_000, 1_000_000);

/// The rent lost to a bin array nobody can close, in lamports.
const LOST_RENT_LAMPORTS: i128 = 70_000_000;

/// The smallest and largest airdrops, in lamports.
const AIRDROP_LAMPORTS: (i64, i64) = (10_000_000, 200_000_000);

/// How many days before the anchor the busy wallet bought the unpriced token.
const UNPRICED_PURCHASE_DAYS_AGO: i64 = 20;

/// What a wallet's entries are generated from.
pub(crate) struct EntryPlan<'a> {
    /// The wallet.
    pub(crate) profile: &'a WalletProfile,
    /// Its address.
    pub(crate) wallet: Address,
    /// When it first did anything.
    pub(crate) first_activity: Timestamp,
    /// Its closed positions.
    pub(crate) closed: &'a [ClosedPositionFacts],
    /// Its open positions.
    pub(crate) open: &'a [OpenPositionFacts],
}

/// Collects a wallet's entries, numbering their signatures.
struct Entries<'a> {
    plan: &'a EntryPlan<'a>,
    list: Vec<WalletEntry>,
}

impl Entries<'_> {
    fn push(&mut self, at: Timestamp, kind: WalletEntryKind, amount: i128) {
        let label = format!("entry:{}:{}", self.plan.profile.label, self.list.len());
        self.list.push(WalletEntry {
            wallet: self.plan.wallet,
            at,
            kind,
            amount: SignedLamports(amount),
            signature: Some(signature(&label)),
        });
    }
}

/// The entries of the wallet of `plan`, without the top-up deposits.
pub(crate) fn wallet_entries(
    seed: u64,
    plan: &EntryPlan<'_>,
    timeline: &Timeline,
) -> Vec<WalletEntry> {
    let mut stream = Stream::of(seed, &format!("entries:{}", plan.profile.label));
    let mut entries = Entries {
        plan,
        list: Vec::new(),
    };
    let first_deposit = plan.profile.first_deposit_sol.saturating_mul(SOL);
    entries.push(
        plan.first_activity,
        WalletEntryKind::CapitalDeposit,
        first_deposit,
    );
    let transactions = plan
        .closed
        .iter()
        .flat_map(|position| [position.opened_at, position.closed_at])
        .chain(plan.open.iter().map(|position| position.opened_at));
    for at in transactions.collect::<Vec<_>>() {
        transaction_costs(&mut stream, &mut entries, at);
    }
    let (count, worst, best) = plan.profile.outside_trades;
    let earliest = plan.first_activity.as_second().saturating_add(3_600);
    let latest = timeline.anchor.as_second().saturating_sub(3_600);
    for _ in 0..count {
        let at = Timestamp::from_second(stream.rising(earliest, latest)).unwrap_or(timeline.anchor);
        let amount = i128::from(stream.between(
            i64::try_from(worst).unwrap_or(0),
            i64::try_from(best).unwrap_or(0),
        ));
        entries.push(at, WalletEntryKind::PureTrading, amount);
    }
    for _ in 0..plan.profile.airdrops {
        let at = Timestamp::from_second(stream.rising(earliest, latest)).unwrap_or(timeline.anchor);
        let amount = i128::from(stream.between(AIRDROP_LAMPORTS.0, AIRDROP_LAMPORTS.1));
        entries.push(at, WalletEntryKind::OtherActivity, amount);
    }
    if plan.profile.buys_unpriced_token {
        let at = timeline
            .anchor
            .checked_sub(SignedDuration::from_hours(
                UNPRICED_PURCHASE_DAYS_AGO.saturating_mul(24),
            ))
            .unwrap_or(timeline.anchor);
        entries.push(
            at,
            WalletEntryKind::UnvaluedPurchase,
            UNPRICED_TOKEN_COST_LAMPORTS.saturating_neg(),
        );
    }
    entries.list.sort_by_key(|entry| entry.at);
    entries.list
}

/// The costs of one transaction: base fee and priority fee, sometimes a tip, a failed attempt or
/// lost rent.
fn transaction_costs(stream: &mut Stream, entries: &mut Entries<'_>, at: Timestamp) {
    entries.push(
        at,
        WalletEntryKind::NetworkFee,
        NETWORK_FEE_LAMPORTS.saturating_neg(),
    );
    let priority = i128::from(stream.between(PRIORITY_FEE_LAMPORTS.0, PRIORITY_FEE_LAMPORTS.1));
    entries.push(at, WalletEntryKind::PriorityFee, priority.saturating_neg());
    if stream.chance(5) {
        let tip = i128::from(stream.between(TIP_LAMPORTS.0, TIP_LAMPORTS.1));
        entries.push(at, WalletEntryKind::Tip, tip.saturating_neg());
    }
    if stream.chance(1) {
        let before = at.checked_sub(SignedDuration::from_secs(30)).unwrap_or(at);
        entries.push(
            before,
            WalletEntryKind::FailedTransaction,
            NETWORK_FEE_LAMPORTS
                .saturating_add(priority)
                .saturating_neg(),
        );
    }
    if stream.below(400) == 0 {
        entries.push(
            at,
            WalletEntryKind::LostRent,
            LOST_RENT_LAMPORTS.saturating_neg(),
        );
    }
}
