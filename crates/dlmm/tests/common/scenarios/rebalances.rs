//! Scenarios of rebalances and what they harvest (decoder oracles D-7 and D-8).

use binsight_dlmm::event::DlmmEvent;

use super::Scenario;
use binsight_solana::Address;
use binsight_solana::transaction::{InstructionData, InstructionNode};
use binsight_solana::well_known::TOKEN_PROGRAM;

use crate::common::{
    address, at, dlmm_instruction, empty_transaction, event_call, fee_claim, located, rebalance,
    reward_claim, transaction,
};

/// The SPL Token instruction tag of `TransferChecked`.
const TRANSFER_CHECKED: u8 = 12;

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

/// A rebalance that adds 11 X, harvests fees of (11, 0) and rewards of 11 and 22, with the
/// transfers it made: the fee of 11 out of reserve X (account 5), the deposit of 11 into it,
/// then each reward from its vault (70 and 80) in its mint (71 and 81). Only the rewards neither
/// leave nor enter a reserve, and the rebalance names neither reward mint among its accounts.
pub(super) fn rewards_with_transfers() -> Scenario {
    let accounts: Vec<_> = (0..17).map(|index| address(30 + index)).collect();
    let reserve_x = accounts[5];
    let rebalanced = rebalance([0, 0, 11, 0, 11, 0], [11, 22], -3);
    let instructions = vec![
        dlmm_instruction(0, "rebalance_liquidity", accounts),
        token_transfer_checked((0, 0), (reserve_x, address(90), address(91)), 11),
        token_transfer_checked((0, 1), (address(91), address(90), reserve_x), 11),
        token_transfer_checked((0, 2), (address(70), address(71), address(72)), 11),
        token_transfer_checked((0, 3), (address(80), address(81), address(82)), 22),
        event_call(0, 4, 2),
    ];
    Scenario {
        tx: transaction(instructions, Vec::new()),
        events: vec![located(0, 4, DlmmEvent::Rebalancing(rebalanced))],
    }
}

/// A `TransferChecked` of `amount` by the token program, as the inner instruction `(top, inner)`
/// at stack height 2: `accounts` are the source, the mint and the destination.
pub(crate) fn token_transfer_checked(
    (top, inner): (u16, u16),
    (source, mint, destination): (Address, Address, Address),
    amount: u64,
) -> InstructionNode {
    let mut data = vec![TRANSFER_CHECKED];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(6);
    InstructionNode {
        position: at(top, inner),
        stack_height: Some(2),
        program: TOKEN_PROGRAM,
        accounts: vec![source, mint, destination, address(100)],
        data: InstructionData(data),
    }
}
