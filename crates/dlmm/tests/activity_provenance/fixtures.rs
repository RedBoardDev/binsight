//! Synthetic CPI event bytes; each derivation must decode these rather than injected events.

use binsight_dlmm::event::EventName;
use binsight_dlmm::program::EVENT_IX_TAG;
use binsight_solana::transaction::{InstructionData, InstructionNode};

use crate::common::{address, event_call};

fn event(name: EventName, location: (u16, u16), fields: &[u8]) -> InstructionNode {
    let mut node = event_call(location.0, location.1, 2);
    node.data = InstructionData(
        [
            EVENT_IX_TAG.as_slice(),
            name.discriminator().as_slice(),
            fields,
        ]
        .concat(),
    );
    node
}

fn addresses(bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .flat_map(|&byte| address(byte).as_bytes().to_vec())
        .collect()
}

pub(super) fn fee(name: EventName, location: (u16, u16), amount: u64) -> InstructionNode {
    let mut fields = addresses(&[1, 2, 100]);
    fields.extend_from_slice(&0_u64.to_le_bytes());
    fields.extend_from_slice(&amount.to_le_bytes());
    if name == EventName::ClaimFee2 {
        fields.extend_from_slice(&7_i32.to_le_bytes());
    }
    event(name, location, &fields)
}

pub(super) fn reward(location: (u16, u16), amount: u64) -> InstructionNode {
    let mut fields = addresses(&[1, 2, 100]);
    fields.extend_from_slice(&0_u64.to_le_bytes());
    fields.extend_from_slice(&amount.to_le_bytes());
    fields.extend_from_slice(&7_i32.to_le_bytes());
    event(EventName::ClaimReward2, location, &fields)
}

pub(super) fn rebalance(top: u16, amounts: [u64; 6], rewards: [u64; 2]) -> InstructionNode {
    let mut fields = addresses(&[1, 2, 100]);
    fields.extend_from_slice(&7_i32.to_le_bytes());
    for amount in amounts {
        fields.extend_from_slice(&amount.to_le_bytes());
    }
    fields.extend_from_slice(&[0; 16]);
    for reward in rewards {
        fields.extend_from_slice(&reward.to_le_bytes());
    }
    event(EventName::Rebalancing, (top, 0), &fields)
}

pub(super) fn create(top: u16) -> InstructionNode {
    event(
        EventName::PositionCreate,
        (top, 0),
        &addresses(&[1, 2, 100]),
    )
}

pub(super) fn close(top: u16) -> InstructionNode {
    event(EventName::PositionClose, (top, 0), &addresses(&[2, 100]))
}

pub(super) fn add(top: u16, amount: u64) -> InstructionNode {
    let mut fields = addresses(&[1, 100, 2]);
    fields.extend_from_slice(&amount.to_le_bytes());
    fields.extend_from_slice(&0_u64.to_le_bytes());
    fields.extend_from_slice(&7_i32.to_le_bytes());
    event(EventName::AddLiquidity, (top, 0), &fields)
}

pub(super) fn without_scope(mut node: InstructionNode) -> InstructionNode {
    node.stack_height = None;
    node
}
