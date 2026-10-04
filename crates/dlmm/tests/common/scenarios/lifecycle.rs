//! Scenarios of liquidity, the position lifecycle, swaps and unknown events.

use binsight_dlmm::event::{DlmmEvent, PositionClosed, PositionCreated};
use binsight_solana::transaction::TxOutcome;

use super::Scenario;
use crate::common::{
    address, dlmm_instruction, empty_transaction, event_call, lamports, liquidity, located, swap,
    transaction,
};

fn closed() -> DlmmEvent {
    DlmmEvent::PositionClose(PositionClosed {
        position: address(2),
        owner: address(100),
    })
}

fn created() -> DlmmEvent {
    DlmmEvent::PositionCreate(PositionCreated {
        lb_pair: address(1),
        position: address(2),
        owner: address(100),
    })
}

pub(super) fn add_liquidity() -> Scenario {
    let change = liquidity(1, 2, (205_945_537_665, 3_376_692_725), -437);
    Scenario {
        tx: empty_transaction(),
        events: vec![located(0, 0, DlmmEvent::AddLiquidity(change))],
    }
}

pub(super) fn zero_deposit() -> Scenario {
    Scenario {
        tx: empty_transaction(),
        events: vec![located(
            0,
            0,
            DlmmEvent::AddLiquidity(liquidity(1, 2, (0, 0), -12)),
        )],
    }
}

pub(super) fn position_create() -> Scenario {
    Scenario {
        tx: empty_transaction(),
        events: vec![located(0, 0, created())],
    }
}

pub(super) fn failed_transaction() -> Scenario {
    let mut tx = empty_transaction();
    tx.outcome = TxOutcome::Failed {
        error: "{\"InstructionError\":[0,{\"Custom\":1}]}".to_owned(),
    };
    let removed = DlmmEvent::RemoveLiquidity(liquidity(1, 2, (1, 1), 0));
    Scenario {
        tx,
        events: vec![located(0, 0, removed), located(0, 1, closed())],
    }
}

pub(super) fn close_without_event() -> Scenario {
    let close = dlmm_instruction(3, "close_position2", vec![address(2), address(200)]);
    Scenario {
        tx: transaction(vec![close], vec![lamports(address(2), 57_000_000, 0)]),
        events: Vec::new(),
    }
}

pub(super) fn close_if_empty_not_empty() -> Scenario {
    let close = dlmm_instruction(0, "close_position_if_empty", vec![address(2)]);
    let balance = lamports(address(2), 57_000_000, 57_000_000);
    Scenario {
        tx: transaction(vec![close], vec![balance]),
        events: Vec::new(),
    }
}

pub(super) fn close_with_event() -> Scenario {
    let close = dlmm_instruction(0, "close_position_if_empty", vec![address(2)]);
    Scenario {
        tx: transaction(vec![close], vec![lamports(address(2), 57_000_000, 0)]),
        events: vec![located(0, 0, closed())],
    }
}

/// A position closed, then created again at the same address, in one transaction.
pub(super) fn close_and_recreate() -> Scenario {
    let close = dlmm_instruction(0, "close_position2", vec![address(2)]);
    let open = dlmm_instruction(1, "initialize_position", vec![address(200), address(2)]);
    let balance = lamports(address(2), 57_000_000, 57_000_000);
    Scenario {
        tx: transaction(vec![close, open], vec![balance]),
        events: vec![located(0, 0, closed()), located(1, 0, created())],
    }
}

pub(super) fn open_without_event() -> Scenario {
    let open = dlmm_instruction(
        2,
        "initialize_position_pda",
        vec![address(200), address(9), address(2)],
    );
    Scenario {
        tx: transaction(vec![open], vec![lamports(address(2), 0, 57_000_000)]),
        events: Vec::new(),
    }
}

pub(super) fn swap_second_form_only() -> Scenario {
    Scenario {
        tx: empty_transaction(),
        events: vec![located(2, 4, DlmmEvent::Swap2(swap()))],
    }
}

/// One `swap2` call that emits its swap as `Swap` and as `Swap2Evt`.
pub(super) fn swap_both_forms_one_call() -> Scenario {
    let instructions = vec![
        dlmm_instruction(1, "swap2", vec![address(1)]),
        event_call(1, 0, 2),
        event_call(1, 1, 2),
    ];
    Scenario {
        tx: transaction(instructions, Vec::new()),
        events: vec![
            located(1, 0, DlmmEvent::Swap(swap())),
            located(1, 1, DlmmEvent::Swap2(swap())),
        ],
    }
}

pub(super) fn unknown_event() -> Scenario {
    let unknown = DlmmEvent::Unknown {
        discriminator: [7; 8],
    };
    Scenario {
        tx: empty_transaction(),
        events: vec![located(0, 0, unknown)],
    }
}
