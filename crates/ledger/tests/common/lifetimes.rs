//! Honest synthetic lifecycle sources reuse the transaction accounting builders.
#![allow(
    dead_code,
    reason = "the lifecycle and evidence test binaries use different builders"
)]

#[path = "book.rs"]
pub(crate) mod book;

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::{LifecycleFact, MovementKind, PositionMovement, RewardClaim};
use binsight_ledger::facts::HistoryCoverage;
use binsight_ledger::positions::{
    PositionReplayContext, PositionTransaction, TransactionOrderProof,
};
use binsight_solana::transaction::InstructionPosition;
use binsight_solana::{Address, Signature};
use jiff::Timestamp;

pub(crate) const WALLET: Address = Address::from_bytes([1; 32]);
pub(crate) const POSITION: Address = Address::from_bytes([11; 32]);
pub(crate) const POOL: Address = Address::from_bytes([12; 32]);
pub(crate) const FOREIGN: Address = Address::from_bytes([9; 32]);

pub(crate) fn context() -> PositionReplayContext {
    PositionReplayContext {
        wallet: WALLET,
        history: HistoryCoverage::Complete,
        observed_at: time(1_000),
        sources_contiguous: true,
    }
}

#[expect(
    clippy::unwrap_used,
    reason = "synthetic timestamp seconds are in Jiff's range"
)]
pub(crate) fn time(seconds: i64) -> Timestamp {
    Timestamp::from_second(seconds).unwrap()
}

pub(crate) fn at(top: u16) -> InstructionPosition {
    InstructionPosition { top, inner: None }
}

#[expect(
    clippy::unwrap_used,
    reason = "synthetic slots are below the signed timestamp bound"
)]
pub(crate) fn source(seed: u8, slot: u64) -> PositionTransaction {
    let mut transaction = book::transaction(1_000_000, 995_000);
    transaction.signature = Signature::from_bytes([seed; 64]);
    transaction.slot = slot;
    transaction.block_time = Some(time(i64::try_from(slot).unwrap()));
    PositionTransaction {
        wallet: WALLET,
        transaction,
        activity: binsight_dlmm::activity::TxActivity::default(),
        order: Some(TransactionOrderProof::Canonical { index: 0 }),
    }
}

pub(crate) fn created(top: u16, owner: Address) -> LifecycleFact {
    LifecycleFact::Created {
        at: at(top),
        position: POSITION,
        pool: POOL,
        owner,
    }
}

pub(crate) fn closed(top: u16, owner: Address) -> LifecycleFact {
    LifecycleFact::Closed {
        at: at(top),
        position: POSITION,
        owner,
    }
}

pub(crate) fn movement(top: u16, x: u128, y: u128) -> PositionMovement {
    PositionMovement {
        at: at(top),
        position: POSITION,
        pool: POOL,
        kind: MovementKind::Deposit,
        x: RawTokenAmount(x),
        y: RawTokenAmount(y),
        price_bin: Some(0),
    }
}

pub(crate) fn reward(top: u16, amount: u128) -> RewardClaim {
    RewardClaim {
        at: at(top),
        position: POSITION,
        pool: POOL,
        reward_index: 1,
        mint: Some(Address::from_bytes([15; 32])),
        amount: RawTokenAmount(amount),
    }
}

pub(crate) fn opening(seed: u8, slot: u64) -> PositionTransaction {
    let mut source = source(seed, slot);
    source.activity.lifecycle.push(created(0, WALLET));
    source
}

pub(crate) fn closing(seed: u8, slot: u64) -> PositionTransaction {
    let mut source = source(seed, slot);
    source.activity.lifecycle.push(closed(0, WALLET));
    source
}
