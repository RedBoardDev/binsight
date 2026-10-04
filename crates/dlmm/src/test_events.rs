//! Builders for the unit tests: synthetic DLMM events, instructions and transactions.
//!
//! The mainnet fixtures cover real shapes; these builders cover the shapes no public transaction
//! shows (a cut event, a claim batch in an exact order), without hand-written byte arrays.

use binsight_core::units::Lamports;
use binsight_solana::transaction::{
    FeeBreakdown, InstructionData, InstructionNode, InstructionPosition, TransactionView,
    TxOutcome, TxVersion,
};
use binsight_solana::{Address, Signature};

use crate::event::EventName;
use crate::program::{EVENT_AUTHORITY, EVENT_IX_TAG, PROGRAM_ID};

/// The data of a DLMM event instruction, built field by field in Borsh.
#[derive(Debug, Clone)]
pub(crate) struct EventBytes(Vec<u8>);

impl EventBytes {
    /// The tag and the discriminator of `name`, without fields yet.
    pub(crate) fn new(name: EventName) -> Self {
        let mut bytes = EVENT_IX_TAG.to_vec();
        bytes.extend_from_slice(&name.discriminator());
        Self(bytes)
    }

    pub(crate) fn address(self, value: Address) -> Self {
        self.bytes(value.as_bytes())
    }

    pub(crate) fn u8(self, value: u8) -> Self {
        self.bytes(&[value])
    }

    pub(crate) fn u32(self, value: u32) -> Self {
        self.bytes(&value.to_le_bytes())
    }

    pub(crate) fn i32(self, value: i32) -> Self {
        self.bytes(&value.to_le_bytes())
    }

    pub(crate) fn u64(self, value: u64) -> Self {
        self.bytes(&value.to_le_bytes())
    }

    pub(crate) fn u128(self, value: u128) -> Self {
        self.bytes(&value.to_le_bytes())
    }

    pub(crate) fn bytes(mut self, more: &[u8]) -> Self {
        self.0.extend_from_slice(more);
        self
    }

    pub(crate) fn to_vec(&self) -> Vec<u8> {
        self.0.clone()
    }
}

/// An event instruction carrying `data`, as the inner instruction `inner` of the top-level
/// instruction `top`.
pub(crate) fn event_instruction(top: u16, inner: u16, data: Vec<u8>) -> InstructionNode {
    InstructionNode {
        position: InstructionPosition {
            top,
            inner: Some(inner),
        },
        stack_height: Some(3),
        program: PROGRAM_ID,
        accounts: vec![EVENT_AUTHORITY],
        data: InstructionData(data),
    }
}

/// A successful transaction made of `instructions`; every other field is a placeholder.
pub(crate) fn transaction_with(instructions: Vec<InstructionNode>) -> TransactionView {
    TransactionView {
        signature: Signature::from_bytes([1; 64]),
        slot: 1,
        block_time: None,
        transaction_index: None,
        version: TxVersion::V0,
        outcome: TxOutcome::Succeeded,
        fee_payer: Address::from_bytes([1; 32]),
        fee: FeeBreakdown {
            total: Lamports(5_000),
            base: Lamports(5_000),
            priority: Lamports(0),
        },
        accounts: Vec::new(),
        instructions,
        native_balances: Vec::new(),
        token_balances: Vec::new(),
    }
}
