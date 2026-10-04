//! The state of the demo instance: the engine, the chain tip, the credits and each wallet's sync.

use binsight_engine::EngineStatus;
use binsight_engine::portfolio::InstanceStatus;
use binsight_engine::portfolio::views::{ChainTip, WalletSync};
use jiff::Timestamp;
use jiff::tz::TimeZone;

use super::sweep::CashFlows;
use crate::scenario::{CREDITS_BUDGET, CREDITS_PER_DAY, VALUATION_INTERVAL_SECONDS, WalletProfile};

/// A slot and the instant it was produced, to place the chain tip of any instant.
const REFERENCE_SLOT: (u64, i64) = (370_000_000, 1_760_000_000);

/// Slots per ten seconds (about 2.5 a second).
const SLOTS_PER_TEN_SECONDS: u64 = 25;

/// The instance as it stands at `anchor`.
pub(crate) fn instance_status(anchor: Timestamp) -> InstanceStatus {
    let elapsed = u64::try_from(anchor.as_second().saturating_sub(REFERENCE_SLOT.1)).unwrap_or(0);
    let day_of_month = u64::try_from(anchor.to_zoned(TimeZone::UTC).day()).unwrap_or(1);
    InstanceStatus {
        engine: EngineStatus::Running,
        started_at: anchor,
        chain: ChainTip {
            last_slot: Some(
                REFERENCE_SLOT
                    .0
                    .saturating_add(elapsed.saturating_mul(SLOTS_PER_TEN_SECONDS) / 10),
            ),
            last_slot_at: Some(anchor),
        },
        valuation_interval_seconds: Some(VALUATION_INTERVAL_SECONDS),
        credits_used: day_of_month
            .saturating_mul(CREDITS_PER_DAY)
            .saturating_sub(day_of_month.saturating_mul(1_200)),
        credits_budget: CREDITS_BUDGET,
    }
}

/// How the wallet of `flows` is synchronized.
pub(crate) fn wallet_sync(profile: &WalletProfile, flows: &CashFlows<'_>) -> WalletSync {
    let last_tx_at = flows
        .entries
        .iter()
        .map(|entry| entry.at)
        .chain(flows.closed.iter().map(|(position, _)| position.closed_at))
        .chain(flows.open.iter().map(|(position, _)| position.opened_at))
        .max();
    let transactions = flows
        .closed
        .len()
        .saturating_mul(2)
        .saturating_add(flows.open.len())
        .saturating_add(flows.entries.len() / 2);
    WalletSync {
        state: profile.sync.state,
        lag_seconds: profile.sync.lag_seconds,
        last_tx_at,
        indexed_tx: u64::try_from(transactions).unwrap_or(u64::MAX),
        import: None,
    }
}
