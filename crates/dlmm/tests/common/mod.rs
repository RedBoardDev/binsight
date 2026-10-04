//! Shared helpers for the integration tests: the mainnet fixtures of `tests/fixtures/mainnet`, and
//! builders for synthetic transactions and events.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "test helpers fail loudly; each test binary uses a different part"
)]

pub(crate) mod scenarios;

use std::path::{Path, PathBuf};

use binsight_core::units::{Lamports, RawTokenAmount};
use binsight_dlmm::activity::{MovementKind, TxActivity, position_activity};
use binsight_dlmm::event::{
    DlmmEvent, FeeClaimed, LiquidityChanged, LocatedEvent, Rebalanced, RewardClaimed, Swapped,
    decode_events,
};
use binsight_dlmm::program::{EVENT_AUTHORITY, EVENT_IX_TAG, PROGRAM_ID};
use binsight_solana::transaction::{
    FeeBreakdown, InstructionData, InstructionNode, InstructionPosition, NativeBalance,
    TransactionView, TxOutcome, TxVersion, read,
};
use binsight_solana::{Address, Signature};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// A fixture case, as its `case.toml` describes it.
#[derive(Debug, Deserialize)]
pub(crate) struct Case {
    /// The case name (its folder).
    pub(crate) name: String,
    /// The public wallet whose point of view the tests take.
    pub(crate) perspective: Option<String>,
    /// The transactions, in order.
    #[serde(rename = "transaction")]
    pub(crate) transactions: Vec<CaseTransaction>,
}

/// One transaction of a case.
#[derive(Debug, Deserialize)]
pub(crate) struct CaseTransaction {
    /// The JSON file, relative to the case folder.
    pub(crate) file: String,
}

fn mainnet_fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mainnet")
}

/// The case named `name`.
pub(crate) fn case(name: &str) -> Case {
    let path = mainnet_fixtures().join(name).join("case.toml");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    toml::from_str(&text).unwrap()
}

/// The transaction at `position` (from 0) of the case `name`, read.
pub(crate) fn fixture(name: &str, position: usize) -> TransactionView {
    let case = case(name);
    let file = &case.transactions[position].file;
    read(&std::fs::read(mainnet_fixtures().join(name).join(file)).unwrap()).unwrap()
}

/// Every transaction of every case, labelled `<case>-<file stem>`, read, sorted by label.
pub(crate) fn every_fixture() -> Vec<(String, TransactionView)> {
    let mut names: Vec<String> = std::fs::read_dir(mainnet_fixtures())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort();
    names
        .iter()
        .flat_map(|name| {
            let case = case(name);
            (0..case.transactions.len()).map(move |position| {
                let stem = case.transactions[position].file.trim_end_matches(".json");
                (format!("{name}-{stem}"), fixture(name, position))
            })
        })
        .collect()
}

/// The decoded events and the activity of the first transaction of the case `name`.
pub(crate) fn decoded_fixture(name: &str) -> (Vec<LocatedEvent>, TxActivity) {
    let tx = fixture(name, 0);
    let events = decode_events(&tx).unwrap();
    let activity = position_activity(&tx, &events).unwrap();
    (events, activity)
}

/// The kind of each event of the first transaction of the case `name`.
pub(crate) fn kinds_of(name: &str) -> Vec<&'static str> {
    let (events, _) = decoded_fixture(name);
    events.iter().map(|located| located.event.kind()).collect()
}

/// The kind, amounts and bin of each movement of the first transaction of the case `name`.
pub(crate) fn movements_of(name: &str) -> Vec<(MovementKind, u128, u128, Option<i32>)> {
    let (_, activity) = decoded_fixture(name);
    activity
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

/// The reward index, amount and mint of each reward claim of the first transaction of `name`.
pub(crate) fn rewards_of(name: &str) -> Vec<(u64, u128, Option<Address>)> {
    let (_, activity) = decoded_fixture(name);
    activity
        .reward_claims
        .iter()
        .map(|claim| (claim.reward_index, claim.amount.0, claim.mint))
        .collect()
}

/// The address made of 32 times `byte`.
pub(crate) fn address(byte: u8) -> Address {
    Address::from_bytes([byte; 32])
}

/// The address written `text` in base58.
pub(crate) fn parse_address(text: &str) -> Address {
    text.parse().unwrap()
}

/// The amount `value`.
pub(crate) fn amount(value: u128) -> RawTokenAmount {
    RawTokenAmount(value)
}

/// The place of the inner instruction `inner` of the top-level instruction `top`.
pub(crate) fn at(top: u16, inner: u16) -> InstructionPosition {
    InstructionPosition {
        top,
        inner: Some(inner),
    }
}

/// `event`, carried by the inner instruction `inner` of the top-level instruction `top`.
pub(crate) fn located(top: u16, inner: u16, event: DlmmEvent) -> LocatedEvent {
    LocatedEvent {
        at: at(top, inner),
        event,
    }
}

/// A liquidity change of `amounts` on `position` of `pool`, at `bin`.
pub(crate) fn liquidity(
    pool: u8,
    position: u8,
    amounts: (u128, u128),
    bin: i32,
) -> LiquidityChanged {
    LiquidityChanged {
        lb_pair: address(pool),
        from: address(200),
        position: address(position),
        amount_x: amount(amounts.0),
        amount_y: amount(amounts.1),
        active_bin_id: bin,
    }
}

/// A fee claim of `fees` on `position` of `pool`.
pub(crate) fn fee_claim(pool: u8, position: u8, fees: (u128, u128)) -> FeeClaimed {
    FeeClaimed {
        lb_pair: address(pool),
        position: address(position),
        owner: address(100),
        fee_x: amount(fees.0),
        fee_y: amount(fees.1),
    }
}

/// A rebalance of position 2 of pool 1 at `bin`: amounts are `[x withdrawn, y withdrawn, x added,
/// y added, x fee, y fee]`, then the two rewards.
pub(crate) fn rebalance(amounts: [u128; 6], rewards: [u128; 2], bin: i32) -> Rebalanced {
    let [x_withdrawn, y_withdrawn, x_added, y_added, x_fee, y_fee] = amounts;
    Rebalanced {
        lb_pair: address(1),
        position: address(2),
        owner: address(100),
        active_bin_id: bin,
        x_withdrawn_amount: amount(x_withdrawn),
        x_added_amount: amount(x_added),
        y_withdrawn_amount: amount(y_withdrawn),
        y_added_amount: amount(y_added),
        x_fee_amount: amount(x_fee),
        y_fee_amount: amount(y_fee),
        rewards: rewards.map(amount),
    }
}

/// A claim of reward `reward_index` of position 2 of pool 1, paying `total`.
pub(crate) fn reward_claim(reward_index: u64, total: u128) -> RewardClaimed {
    RewardClaimed {
        lb_pair: address(1),
        position: address(2),
        owner: address(100),
        reward_index,
        total_reward: amount(total),
    }
}

/// A swap of 1,000 X for 990 Y in pool 1.
pub(crate) fn swap() -> Swapped {
    Swapped {
        lb_pair: address(1),
        from: address(7),
        start_bin_id: 4,
        end_bin_id: 6,
        amount_in: amount(1_000),
        amount_out: amount(990),
        swap_for_y: true,
    }
}

/// The data of the DLMM instruction `name`, with no parameters.
pub(crate) fn instruction_data(name: &str) -> Vec<u8> {
    Sha256::digest(format!("global:{name}"))[..8].to_vec()
}

/// The top-level DLMM instruction `name` at `top`, given `accounts`.
pub(crate) fn dlmm_instruction(top: u16, name: &str, accounts: Vec<Address>) -> InstructionNode {
    InstructionNode {
        position: InstructionPosition { top, inner: None },
        stack_height: Some(1),
        program: PROGRAM_ID,
        accounts,
        data: InstructionData(instruction_data(name)),
    }
}

/// The event call (an inner DLMM instruction signed by the event authority) at `top`/`inner`,
/// at `stack_height`; its data is only the event tag.
pub(crate) fn event_call(top: u16, inner: u16, stack_height: u8) -> InstructionNode {
    InstructionNode {
        position: at(top, inner),
        stack_height: Some(stack_height),
        program: PROGRAM_ID,
        accounts: vec![EVENT_AUTHORITY],
        data: InstructionData(EVENT_IX_TAG.to_vec()),
    }
}

/// The lamports of `account` before and after.
pub(crate) fn lamports(account: Address, pre: u64, post: u64) -> NativeBalance {
    NativeBalance {
        account,
        pre: Lamports(pre),
        post: Lamports(post),
    }
}

/// A successful transaction of `instructions` and `native_balances`; the rest is placeholder.
pub(crate) fn transaction(
    instructions: Vec<InstructionNode>,
    native_balances: Vec<NativeBalance>,
) -> TransactionView {
    TransactionView {
        signature: Signature::from_bytes([1; 64]),
        slot: 1,
        block_time: None,
        transaction_index: None,
        version: TxVersion::V0,
        outcome: TxOutcome::Succeeded,
        fee_payer: address(200),
        fee: FeeBreakdown {
            total: Lamports(5_000),
            base: Lamports(5_000),
            priority: Lamports(0),
        },
        accounts: Vec::new(),
        instructions,
        native_balances,
        token_balances: Vec::new(),
    }
}

/// A successful transaction with no instruction.
pub(crate) fn empty_transaction() -> TransactionView {
    transaction(Vec::new(), Vec::new())
}
