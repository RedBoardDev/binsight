//! A rebalance that harvests a farm reward books it as a reward of the position, in its mint.
#[path = "common/book.rs"]
mod common;

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::position_activity;
use binsight_dlmm::event::{DlmmEvent, LocatedEvent, Rebalanced};
use binsight_dlmm::program::{EVENT_AUTHORITY, EVENT_IX_TAG, PROGRAM_ID};
use binsight_ledger::book::{Asset, EntryKind, LedgerEntry, WalletContext, book_transaction};
use binsight_solana::transaction::{InstructionData, InstructionNode, InstructionPosition};
use binsight_solana::well_known::TOKEN_PROGRAM;
use common::*;

/// The `rebalance_liquidity` discriminator, as explorers write it.
const REBALANCE_LIQUIDITY: u64 = 0x5c04_b0c1_77b9_5309;

/// The SPL Token instruction tag of `TransferChecked`.
const TRANSFER_CHECKED: u8 = 12;

fn inner(
    inner: u16,
    program: binsight_solana::Address,
    accounts: Vec<binsight_solana::Address>,
    data: Vec<u8>,
) -> InstructionNode {
    InstructionNode {
        position: InstructionPosition {
            top: 0,
            inner: Some(inner),
        },
        stack_height: Some(2),
        program,
        accounts,
        data: InstructionData(data),
    }
}

/// Wallet 1 rebalances its position 2 in pool 3, which moves no liquidity but harvests a reward
/// of 11 tokens of mint 71, paid from the reward vault 70 into the wallet's account 72.
#[test]
fn books_a_reward_harvested_by_a_rebalance_in_its_own_mint() {
    let (wallet, position, pool, mint) = (address(1), address(2), address(3), address(71));
    let mut tx = transaction(1_000_000, 995_000);
    let mut accounts: Vec<_> = (0..17).map(|index| address(30 + index)).collect();
    accounts[0] = position;
    accounts[1] = pool;
    tx.instructions.push(instruction(
        PROGRAM_ID,
        accounts,
        REBALANCE_LIQUIDITY.to_be_bytes().to_vec(),
    ));
    let mut transfer = vec![TRANSFER_CHECKED];
    transfer.extend(11_u64.to_le_bytes());
    transfer.push(6);
    tx.instructions.push(inner(
        0,
        TOKEN_PROGRAM,
        vec![address(70), mint, address(72), pool],
        transfer,
    ));
    tx.instructions.push(inner(
        1,
        PROGRAM_ID,
        vec![EVENT_AUTHORITY],
        EVENT_IX_TAG.to_vec(),
    ));
    tx.token_balances = vec![
        token(address(70), pool, mint, 11, 0),
        token(address(72), wallet, mint, 0, 11),
    ];
    tx.native_balances.push(native(address(72), 200, 200));
    let zero = RawTokenAmount(0);
    let rebalance = Rebalanced {
        lb_pair: pool,
        position,
        owner: wallet,
        active_bin_id: 7,
        x_withdrawn_amount: zero,
        x_added_amount: zero,
        y_withdrawn_amount: zero,
        y_added_amount: zero,
        x_fee_amount: zero,
        y_fee_amount: zero,
        rewards: [RawTokenAmount(11), zero],
    };
    let events = [LocatedEvent {
        at: InstructionPosition {
            top: 0,
            inner: Some(1),
        },
        event: DlmmEvent::Rebalancing(rebalance),
    }];
    let activity = position_activity(&tx, &events).unwrap();
    let mut context = WalletContext::new(wallet);
    context.positions.insert(position);
    let entries: Vec<_> = book_transaction(&context, &tx, &activity)
        .unwrap()
        .into_iter()
        .map(
            |LedgerEntry {
                 asset,
                 amount,
                 kind,
                 ..
             }| (asset, amount, kind),
        )
        .collect();
    assert_eq!(
        entries,
        [
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (
                Asset::Token { mint },
                11,
                EntryKind::RewardClaim { position }
            ),
        ]
    );
}
