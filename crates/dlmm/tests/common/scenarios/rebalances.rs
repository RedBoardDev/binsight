//! Scenarios of rebalances and what they harvest (decoder oracles D-7 and D-8).

use binsight_dlmm::event::DlmmEvent;

use super::Scenario;
use crate::common::{
    address, dlmm_instruction, empty_transaction, event_call, fee_claim, located, rebalance,
    reward_claim, transaction,
};

pub(super) fn harvest() -> Scenario {
    let rebalanced = rebalance([5, 7, 4, 6, 2, 3], [0, 0], -410);
    Scenario {
        tx: empty_transaction(),
        events: vec![located(0, 0, DlmmEvent::Rebalancing(rebalanced))],
    }
}

/// The D-8 events: a rebalance that harvests (2, 3), then a `claim_fee2` call of the same
/// position paying (2, 3) too. `top` 0 is the rebalance and `top` 1 the claim.
fn harvest_and_claim_events() -> Vec<binsight_dlmm::LocatedEvent> {
    let rebalanced = rebalance([0, 0, 0, 6, 2, 3], [0, 0], -410);
    vec![
        located(0, 0, DlmmEvent::Rebalancing(rebalanced)),
        located(1, 0, DlmmEvent::ClaimFee(fee_claim(1, 2, (2, 3)))),
        located(
            1,
            1,
            DlmmEvent::ClaimFee2 {
                claim: fee_claim(1, 2, (2, 3)),
                active_bin_id: -410,
            },
        ),
    ]
}

/// D-8 with the instructions that emitted the events: two instructions, two payments.
pub(super) fn harvest_then_claim() -> Scenario {
    let instructions = vec![
        dlmm_instruction(0, "rebalance_liquidity", vec![address(2)]),
        event_call(0, 0, 2),
        dlmm_instruction(1, "claim_fee2", vec![address(1), address(2)]),
        event_call(1, 0, 2),
        event_call(1, 1, 2),
    ];
    Scenario {
        tx: transaction(instructions, Vec::new()),
        events: harvest_and_claim_events(),
    }
}

/// D-8 without the instructions: the scope is then the whole transaction, so both reports are
/// one claim.
pub(super) fn claim_without_stack_heights() -> Scenario {
    Scenario {
        tx: empty_transaction(),
        events: harvest_and_claim_events(),
    }
}

pub(super) fn claim_of_other_amounts() -> Scenario {
    let rebalanced = rebalance([0, 0, 0, 6, 2, 3], [0, 0], -410);
    let claim = DlmmEvent::ClaimFee2 {
        claim: fee_claim(1, 2, (0, 0)),
        active_bin_id: -410,
    };
    Scenario {
        tx: empty_transaction(),
        events: vec![
            located(0, 0, DlmmEvent::Rebalancing(rebalanced)),
            located(1, 0, claim),
        ],
    }
}

pub(super) fn rewards() -> Scenario {
    let rebalanced = rebalance([0, 0, 0, 0, 0, 0], [11, 22], -3);
    Scenario {
        tx: empty_transaction(),
        events: vec![
            located(0, 0, DlmmEvent::Rebalancing(rebalanced)),
            located(0, 1, DlmmEvent::ClaimReward(reward_claim(1, 22))),
        ],
    }
}
