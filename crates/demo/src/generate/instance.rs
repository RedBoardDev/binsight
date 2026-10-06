//! The state of the demo instance: the engine, the chain tip, the credits and each wallet's sync.

use binsight_engine::EngineStatus;
use binsight_engine::portfolio::InstanceStatus;
use binsight_engine::portfolio::views::{BillingCycle, ChainTip, WalletSync};
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};

use super::sweep::CashFlows;
use crate::error::DemoError;
use crate::scenario::{CREDITS_BUDGET, CREDITS_PER_DAY, VALUATION_INTERVAL_SECONDS, WalletProfile};

/// A slot and the instant it was produced, to place the chain tip of any instant.
const REFERENCE_SLOT: (u64, i64) = (370_000_000, 1_760_000_000);

/// Slots per ten seconds (about 2.5 a second).
const SLOTS_PER_TEN_SECONDS: u64 = 25;

/// Reset day of the simulated provider, independent of any real governor.
const SIMULATED_CREDIT_RESET_DAY: i8 = 17;
const SECONDS_PER_CREDIT_DAY: u64 = 86_400;
const SAVED_CREDITS_PER_DAY: u64 = 1_200;

/// The instance as it stands at `anchor`.
///
/// # Errors
///
/// Returns an error if its calendar boundaries or counters are out of range.
pub(crate) fn instance_status(anchor: Timestamp) -> Result<InstanceStatus, DemoError> {
    let elapsed = u64::try_from(anchor.as_second().saturating_sub(REFERENCE_SLOT.1)).unwrap_or(0);
    let credit_cycle = simulated_credit_cycle(anchor)?;
    let credits_used = simulated_cycle_used(anchor, credit_cycle)?;
    Ok(InstanceStatus {
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
        credit_cycle,
        credits_used,
        credits_budget: CREDITS_BUDGET,
        failed_decodes: 0,
    })
}

fn simulated_credit_cycle(anchor: Timestamp) -> Result<BillingCycle, DemoError> {
    let today = anchor.to_zoned(TimeZone::UTC).date();
    let month = if today.day() < SIMULATED_CREDIT_RESET_DAY {
        today
            .checked_sub(1.month())
            .map_err(|_| DemoError::OutOfRange)?
    } else {
        today
    };
    let first = month
        .with()
        .day(SIMULATED_CREDIT_RESET_DAY)
        .build()
        .map_err(|_| DemoError::OutOfRange)?;
    let next = first
        .checked_add(1.month())
        .map_err(|_| DemoError::OutOfRange)?;
    let midnight = |day: jiff::civil::Date| {
        day.to_zoned(TimeZone::UTC)
            .map(|instant| instant.timestamp())
            .map_err(|_| DemoError::OutOfRange)
    };
    Ok(BillingCycle {
        start: midnight(first)?,
        end: midnight(next)?,
    })
}

fn simulated_cycle_used(anchor: Timestamp, credit_cycle: BillingCycle) -> Result<u64, DemoError> {
    let seconds = u64::try_from(
        anchor
            .as_second()
            .checked_sub(credit_cycle.start.as_second())
            .ok_or(DemoError::OutOfRange)?,
    )
    .map_err(|_| DemoError::OutOfRange)?;
    let daily = CREDITS_PER_DAY
        .checked_sub(SAVED_CREDITS_PER_DAY)
        .ok_or(DemoError::OutOfRange)?;
    u128::from(seconds)
        .checked_mul(u128::from(daily))
        .and_then(|spent| spent.checked_div(u128::from(SECONDS_PER_CREDIT_DAY)))
        .and_then(|spent| u64::try_from(spent).ok())
        .ok_or(DemoError::OutOfRange)
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
