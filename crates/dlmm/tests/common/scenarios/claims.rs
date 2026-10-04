//! Scenarios of fee and reward claims (decoder oracles D-2 to D-6, correction X-5).

use binsight_dlmm::LocatedEvent;
use binsight_dlmm::event::DlmmEvent;
use binsight_solana::transaction::{InstructionData, InstructionNode};

use super::Scenario;
use crate::common::{
    address, dlmm_instruction, empty_transaction, event_call, fee_claim, liquidity, located,
    reward_claim, transaction,
};

fn second_form(fees: (u128, u128), bin: i32) -> DlmmEvent {
    DlmmEvent::ClaimFee2 {
        claim: fee_claim(1, 2, fees),
        active_bin_id: bin,
    }
}

pub(super) fn both_forms_after_remove() -> Scenario {
    let removed = DlmmEvent::RemoveLiquidity(liquidity(1, 2, (0, 9), -429));
    Scenario {
        tx: empty_transaction(),
        events: vec![
            located(0, 0, removed),
            located(1, 0, DlmmEvent::ClaimFee(fee_claim(1, 2, (0, 46_620_648)))),
            located(1, 1, second_form((0, 46_620_648), -437)),
        ],
    }
}

/// A batch where only the first claim has a twin of the second form, without stack heights.
pub(super) fn batch_without_twins() -> Scenario {
    Scenario {
        tx: empty_transaction(),
        events: vec![
            located(0, 0, second_form((0, 100), -5)),
            located(0, 1, DlmmEvent::ClaimFee(fee_claim(1, 2, (0, 100)))),
            located(1, 0, DlmmEvent::ClaimFee(fee_claim(1, 3, (0, 250)))),
        ],
    }
}

pub(super) fn emitted_twice() -> Scenario {
    Scenario {
        tx: empty_transaction(),
        events: vec![
            located(0, 0, second_form((7, 8), 3)),
            located(0, 1, second_form((7, 8), 3)),
        ],
    }
}

pub(super) fn borrows_pool_bin() -> Scenario {
    let removed = DlmmEvent::RemoveLiquidity(liquidity(1, 2, (1, 1), -429));
    Scenario {
        tx: empty_transaction(),
        events: vec![
            located(0, 0, removed),
            located(1, 0, DlmmEvent::ClaimFee(fee_claim(1, 2, (0, 5)))),
        ],
    }
}

pub(super) fn alone_without_bin() -> Scenario {
    let claim = fee_claim(1, 2, (896_784_000, 112_397_677));
    Scenario {
        tx: empty_transaction(),
        events: vec![located(0, 0, DlmmEvent::ClaimFee(claim))],
    }
}

pub(super) fn other_pool_bin() -> Scenario {
    let added = DlmmEvent::AddLiquidity(liquidity(9, 8, (1, 1), -10));
    Scenario {
        tx: empty_transaction(),
        events: vec![
            located(0, 0, added),
            located(1, 0, DlmmEvent::ClaimFee(fee_claim(1, 2, (0, 5)))),
        ],
    }
}

/// A `claim_fee2` call at `top` and its two events (both forms) paying `fees`.
fn claim_fee2_call(top: u16, fees: (u128, u128)) -> (Vec<InstructionNode>, Vec<LocatedEvent>) {
    let accounts = vec![address(1), address(2), address(100)];
    let instructions = vec![
        dlmm_instruction(top, "claim_fee2", accounts),
        event_call(top, 0, 2),
        event_call(top, 1, 2),
    ];
    let events = vec![
        located(top, 0, DlmmEvent::ClaimFee(fee_claim(1, 2, fees))),
        located(top, 1, second_form(fees, -7)),
    ];
    (instructions, events)
}

pub(super) fn equal_amounts_two_calls() -> Scenario {
    let (mut instructions, mut events) = claim_fee2_call(0, (0, 29_075));
    let (more_instructions, more_events) = claim_fee2_call(1, (0, 29_075));
    instructions.extend(more_instructions);
    events.extend(more_events);
    Scenario {
        tx: transaction(instructions, Vec::new()),
        events,
    }
}

pub(super) fn both_forms_one_call() -> Scenario {
    let (instructions, events) = claim_fee2_call(4, (5, 6));
    Scenario {
        tx: transaction(instructions, Vec::new()),
        events,
    }
}

pub(super) fn reward_mint_from_instruction() -> Scenario {
    let accounts = vec![
        address(1),
        address(2),
        address(200),
        address(50),
        address(60),
    ];
    let mut claim = dlmm_instruction(0, "claim_reward2", accounts);
    claim.data = InstructionData([claim.data.0, vec![0; 16]].concat());
    let event = DlmmEvent::ClaimReward2 {
        claim: reward_claim(0, 1_000),
        active_bin_id: 12,
    };
    Scenario {
        tx: transaction(vec![claim, event_call(0, 0, 2)], Vec::new()),
        events: vec![located(0, 0, event)],
    }
}
