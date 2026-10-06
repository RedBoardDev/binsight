//! Which balance changes of a protocol transaction are the legs of a swap.
#[path = "common/book.rs"]
mod common;

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::{MovementKind, PositionMovement, TxActivity};
use binsight_dlmm::program::{EVENT_AUTHORITY, EVENT_IX_TAG, PROGRAM_ID};
use binsight_ledger::book::{Asset, EntryKind, LedgerEntry, WalletContext, book_transaction};
use binsight_solana::Address;
use binsight_solana::transaction::{InstructionPosition, TransactionView};
use binsight_solana::well_known::{TOKEN_PROGRAM, USDC_MINT, WSOL_MINT};
use common::*;

#[expect(
    clippy::unwrap_used,
    reason = "a test transaction must book successfully"
)]
fn entries_of(tx: &TransactionView, activity: &TxActivity) -> Vec<(Asset, i128, EntryKind)> {
    book_transaction(&WalletContext::new(address(1)), tx, activity)
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
        .collect()
}

fn assert_same_entries(actual: &[(Asset, i128, EntryKind)], expected: &[(Asset, i128, EntryKind)]) {
    assert_eq!(actual.len(), expected.len(), "{actual:?}");
    for entry in expected {
        assert!(actual.contains(entry), "missing {entry:?} in {actual:?}");
    }
}

/// An SPL `Transfer` of `amount` from `source` to `destination`, called by the top-level
/// instruction as its inner instruction `inner`.
fn token_transfer(
    source: Address,
    destination: Address,
    amount: u64,
    inner: u16,
) -> binsight_solana::transaction::InstructionNode {
    let mut data = vec![3];
    data.extend(amount.to_le_bytes());
    let mut node = instruction(TOKEN_PROGRAM, vec![source, destination, address(1)], data);
    node.position.inner = Some(inner);
    node.stack_height = Some(2);
    node
}

/// A route sells 100 X for 30 Y through USDC: 1,000 USDC land in the wallet's account and 995
/// leave it again. The 5 USDC left over are 0.5 % of what the account received, so USDC is not a
/// third leg: it stays the route's.
#[test]
fn leaves_a_token_the_route_passes_through_out_of_the_swap() {
    let wallet = address(1);
    let (x, y) = (address(9), address(8));
    let (x_account, usdc_account, y_account) = (address(2), address(4), address(3));
    let mut tx = transaction(1_000_000, 995_000);
    tx.token_balances = vec![
        token(x_account, wallet, x, 100, 0),
        token(usdc_account, wallet, USDC_MINT, 0, 5),
        token(y_account, wallet, y, 0, 30),
        token(address(30), address(25), x, 0, 100),
        token(address(31), address(25), USDC_MINT, 1_000, 0),
        token(address(32), address(25), USDC_MINT, 0, 995),
        token(address(33), address(25), y, 30, 0),
    ];
    for account in [x_account, usdc_account, y_account] {
        tx.native_balances.push(native(account, 200, 200));
    }
    tx.instructions
        .push(instruction(address(22), vec![], vec![1]));
    tx.instructions.extend([
        token_transfer(x_account, address(30), 100, 0),
        token_transfer(address(31), usdc_account, 1_000, 1),
        token_transfer(usdc_account, address(32), 995, 2),
        token_transfer(address(33), y_account, 30, 3),
    ]);
    assert_same_entries(
        &entries_of(&tx, &TxActivity::default()),
        &[
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (Asset::Token { mint: x }, -100, EntryKind::SwapOut),
            (Asset::Token { mint: y }, 30, EntryKind::SwapIn),
            (
                Asset::Token { mint: USDC_MINT },
                5,
                EntryKind::ProtocolActivity {
                    program: address(22),
                },
            ),
        ],
    );
}

/// The wallet transfers 100,000 lamports of wrapped SOL into a pool for 20 tokens and pays 7,000
/// native lamports to an account no list knows. SOL is counted as wrapped SOL, so the native
/// payment stays the protocol's instead of becoming a third leg.
#[test]
fn keeps_a_stray_native_sol_change_beside_a_wrapped_sol_swap_out_of_the_legs() {
    let (wallet, wsol_account, token_account, mint) =
        (address(1), address(2), address(3), address(9));
    let mut tx = transaction(1_000_000, 988_000);
    tx.token_balances = vec![
        token(wsol_account, wallet, WSOL_MINT, 100_000, 0),
        token(token_account, wallet, mint, 0, 20),
        token(address(30), address(25), WSOL_MINT, 0, 100_000),
    ];
    tx.native_balances.extend([
        native(wsol_account, 2_139_280, 2_039_280),
        native(token_account, 2_039_280, 2_039_280),
    ]);
    tx.instructions
        .push(instruction(address(22), vec![], vec![1]));
    tx.instructions
        .push(token_transfer(wsol_account, address(30), 100_000, 0));
    tx.instructions.push(transfer(wallet, address(50), 7_000));
    assert_same_entries(
        &entries_of(&tx, &TxActivity::default()),
        &[
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (
                Asset::Token { mint: WSOL_MINT },
                -100_000,
                EntryKind::SwapOut,
            ),
            (Asset::Token { mint }, 20, EntryKind::SwapIn),
            (
                Asset::Sol,
                -7_000,
                EntryKind::ProtocolActivity {
                    program: address(22),
                },
            ),
        ],
    );
}

/// A program buys 1,000 tokens from the wallet and pays 1,000,000 native lamports, while
/// 2,039,280 lamports of wrapped SOL leave the wallet's account without any transfer (an
/// account the program reopens). No wrapped SOL was transferred, so native SOL is the swap's SOL
/// leg, and the wrapped-SOL change stays the protocol's.
#[test]
fn keeps_native_sol_proceeds_when_wrapped_sol_moved_without_a_transfer() {
    let (wallet, wsol_account, token_account, mint) =
        (address(1), address(2), address(3), address(9));
    let mut tx = transaction(1_000_000, 1_995_000);
    tx.token_balances = vec![
        token(wsol_account, wallet, WSOL_MINT, 2_039_280, 0),
        token(token_account, wallet, mint, 1_000, 0),
        token(address(30), address(25), mint, 0, 1_000),
    ];
    tx.native_balances.extend([
        native(wsol_account, 4_078_560, 2_039_280),
        native(token_account, 2_039_280, 2_039_280),
    ]);
    tx.instructions
        .push(instruction(address(22), vec![], vec![1]));
    tx.instructions
        .push(token_transfer(token_account, address(30), 1_000, 0));
    tx.instructions
        .push(transfer(address(40), wallet, 1_000_000));
    assert_same_entries(
        &entries_of(&tx, &TxActivity::default()),
        &[
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (Asset::Token { mint }, -1_000, EntryKind::SwapOut),
            (Asset::Sol, 1_000_000, EntryKind::SwapIn),
            (
                Asset::Token { mint: WSOL_MINT },
                -2_039_280,
                EntryKind::ProtocolActivity {
                    program: address(22),
                },
            ),
        ],
    );
}

/// A withdrawal of 500 tokens from position 11, which the wallet is not known to own, pays the
/// wallet's account, and the wallet pays 7,000 lamports in the same transaction. The tokens came
/// from a position, not a market: there is no purchase.
#[test]
fn never_reads_a_withdrawal_from_an_unowned_position_as_a_purchase() {
    let (wallet, wallet_account, reserve, mint) = (address(1), address(3), address(5), address(9));
    let mut tx = transaction(1_000_000, 988_000);
    tx.token_balances = vec![
        token(wallet_account, wallet, mint, 0, 500),
        token(reserve, address(12), mint, 500, 0),
    ];
    tx.native_balances.push(native(wallet_account, 200, 200));
    tx.instructions.push(instruction(
        PROGRAM_ID,
        vec![address(11), address(12)],
        vec![1],
    ));
    tx.instructions
        .push(token_transfer(reserve, wallet_account, 500, 0));
    let mut event = instruction(PROGRAM_ID, vec![EVENT_AUTHORITY], EVENT_IX_TAG.to_vec());
    event.position.inner = Some(1);
    event.stack_height = Some(2);
    tx.instructions.push(event);
    let mut payment = transfer(wallet, address(50), 7_000);
    payment.position.top = 1;
    tx.instructions.push(payment);
    let activity = TxActivity {
        movements: vec![PositionMovement {
            at: InstructionPosition {
                top: 0,
                inner: Some(1),
            },
            position: address(11),
            pool: address(12),
            kind: MovementKind::Withdrawal,
            x: RawTokenAmount(500),
            y: RawTokenAmount(0),
            price_bin: Some(0),
        }],
        ..TxActivity::default()
    };
    let dlmm = EntryKind::ProtocolActivity {
        program: PROGRAM_ID,
    };
    assert_same_entries(
        &entries_of(&tx, &activity),
        &[
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (Asset::Token { mint }, 500, dlmm),
            (Asset::Sol, -7_000, dlmm),
        ],
    );
}
