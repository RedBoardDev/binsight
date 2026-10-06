//! Named synthetic transactions, each with its decoded events: the shapes of the activity rules.
//!
//! The rule tests assert what `position_activity` makes of each scenario, and the corpus test
//! records it in `decoder-version.lock`, so that a change to a rule that no mainnet fixture shows
//! still requires a new decoder version.

mod claims;
mod lifecycle;
mod rebalances;

use binsight_dlmm::LocatedEvent;
use binsight_dlmm::activity::{ActivityError, MovementKind, TxActivity, position_activity};
use binsight_solana::transaction::TransactionView;

/// A synthetic transaction and the events decoded from it.
pub(crate) struct Scenario {
    /// The transaction.
    pub(crate) tx: TransactionView,
    /// Its events.
    pub(crate) events: Vec<LocatedEvent>,
}

/// What builds a scenario.
type Build = fn() -> Scenario;

/// Every scenario, by name.
const SCENARIOS: &[(&str, Build)] = &[
    ("add-liquidity", lifecycle::add_liquidity),
    ("zero-deposit", lifecycle::zero_deposit),
    ("position-create", lifecycle::position_create),
    ("failed-transaction", lifecycle::failed_transaction),
    ("close-without-event", lifecycle::close_without_event),
    (
        "close-if-empty-not-empty",
        lifecycle::close_if_empty_not_empty,
    ),
    ("close-with-event", lifecycle::close_with_event),
    ("close-and-recreate", lifecycle::close_and_recreate),
    ("open-without-event", lifecycle::open_without_event),
    ("swap-second-form-only", lifecycle::swap_second_form_only),
    (
        "swap-both-forms-one-call",
        lifecycle::swap_both_forms_one_call,
    ),
    ("unknown-event", lifecycle::unknown_event),
    (
        "claim-both-forms-after-remove",
        claims::both_forms_after_remove,
    ),
    ("claim-batch-without-twins", claims::batch_without_twins),
    ("claim-emitted-twice", claims::emitted_twice),
    ("claim-borrows-pool-bin", claims::borrows_pool_bin),
    ("claim-alone-without-bin", claims::alone_without_bin),
    ("claim-other-pool-bin", claims::other_pool_bin),
    (
        "claim-equal-amounts-two-calls",
        claims::equal_amounts_two_calls,
    ),
    ("claim-both-forms-one-call", claims::both_forms_one_call),
    (
        "reward-mint-from-instruction",
        claims::reward_mint_from_instruction,
    ),
    ("rebalance-harvest", rebalances::harvest),
    (
        "rebalance-harvest-then-claim",
        rebalances::harvest_then_claim,
    ),
    (
        "rebalance-and-claim-without-stack-heights",
        rebalances::claim_without_stack_heights,
    ),
    (
        "rebalance-and-claim-of-other-amounts",
        rebalances::claim_of_other_amounts,
    ),
    ("rebalance-rewards", rebalances::rewards),
    (
        "rebalance-rewards-with-transfers",
        rebalances::rewards_with_transfers,
    ),
];

/// The scenario named `name`.
pub(crate) fn scenario(name: &str) -> Scenario {
    let (_, build) = SCENARIOS
        .iter()
        .find(|(known, _)| *known == name)
        .unwrap_or_else(|| panic!("no scenario named {name}"));
    build()
}

/// Every scenario, with its name.
pub(crate) fn every_scenario() -> Vec<(&'static str, Scenario)> {
    SCENARIOS
        .iter()
        .map(|(name, build)| (*name, build()))
        .collect()
}

/// What `position_activity` makes of the scenario `name`.
pub(crate) fn activity_of(name: &str) -> Result<TxActivity, ActivityError> {
    let Scenario { tx, events } = scenario(name);
    position_activity(&tx, &events)
}

/// The kind, amounts and bin of each movement of the scenario `name`.
pub(crate) fn movement_summary(name: &str) -> Vec<(MovementKind, u128, u128, Option<i32>)> {
    activity_of(name)
        .unwrap()
        .movements
        .iter()
        .map(|movement| {
            (
                movement.kind,
                movement.x.0,
                movement.y.0,
                movement.price_bin,
            )
        })
        .collect()
}
