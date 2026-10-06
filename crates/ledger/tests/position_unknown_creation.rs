//! A position whose creation the history does not hold leaves the rest of its transaction
//! bookable, and is booked as the wallet's when it paid the wallet's own tokens.
#[path = "common/lifetimes.rs"]
mod common;

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::{MovementKind, PositionMovement};
use binsight_dlmm::program::{EVENT_AUTHORITY, EVENT_IX_TAG, PROGRAM_ID};
use binsight_ledger::book::{Asset, EntryKind, WalletContext};
use binsight_ledger::counterparties::LandingService;
use binsight_ledger::positions::{LifetimeDiagnostic, PositionLifetimes};
use binsight_solana::transaction::InstructionPosition;
use binsight_solana::well_known::{SYSTEM_PROGRAM, TOKEN_PROGRAM, WSOL_MINT};
use common::*;

/// The `remove_liquidity` discriminator, as explorers write it.
const REMOVE_LIQUIDITY: u64 = 0x5055_d148_18ce_b16c;

/// The first of Jito's tip accounts.
const JITO_TIP_ACCOUNT: &str = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";

/// The wallet withdraws 500 X from position 11, whose creation the replay never saw, into its
/// own account 3, and tips Jito 10,000 lamports. The transaction books: the fee, the tip, and
/// the withdrawal as the wallet's, while the position stays without an identity.
#[test]
fn books_a_transaction_whose_position_has_an_unknown_creation() {
    let (mint_x, mint_y) = (book::address(9), book::address(8));
    let (wallet_account, reserve_x, reserve_y) =
        (book::address(3), book::address(5), book::address(6));
    let mut source = source(1, 10);
    source.transaction.native_balances[0].post.0 = 985_000;
    let mut accounts = vec![book::address(0); 9];
    accounts[0] = POSITION;
    accounts[1] = POOL;
    accounts[7] = mint_x;
    accounts[8] = mint_y;
    source.transaction.instructions.push(book::instruction(
        PROGRAM_ID,
        accounts,
        REMOVE_LIQUIDITY.to_be_bytes().to_vec(),
    ));
    let mut pay = vec![3];
    pay.extend(500_u64.to_le_bytes());
    let mut pay = book::instruction(TOKEN_PROGRAM, vec![reserve_x, wallet_account, POOL], pay);
    pay.position.inner = Some(0);
    pay.stack_height = Some(2);
    let mut event = book::instruction(PROGRAM_ID, vec![EVENT_AUTHORITY], EVENT_IX_TAG.to_vec());
    event.position.inner = Some(1);
    event.stack_height = Some(2);
    let mut tip = book::transfer(WALLET, JITO_TIP_ACCOUNT.parse().unwrap(), 10_000);
    tip.position.top = 1;
    source.transaction.instructions.extend([pay, event, tip]);
    source.transaction.token_balances = vec![
        book::token(wallet_account, WALLET, mint_x, 0, 500),
        book::token(reserve_x, POOL, mint_x, 500, 0),
        book::token(reserve_y, POOL, mint_y, 0, 0),
    ];
    source
        .transaction
        .native_balances
        .push(book::native(wallet_account, 200, 200));
    let at = InstructionPosition {
        top: 0,
        inner: Some(1),
    };
    source.activity.movements.push(PositionMovement {
        at,
        position: POSITION,
        pool: POOL,
        kind: MovementKind::Withdrawal,
        x: RawTokenAmount(500),
        y: RawTokenAmount(0),
        price_bin: Some(0),
    });
    let signature = source.transaction.signature;
    let mut replay = PositionLifetimes::new(context());
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    let entries: Vec<_> = bundle
        .entries()
        .iter()
        .map(|entry| (entry.asset, entry.amount, entry.kind))
        .collect();
    assert_eq!(
        entries,
        [
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (
                Asset::Sol,
                -10_000,
                EntryKind::Tip {
                    service: LandingService::Jito
                }
            ),
            (
                Asset::Token { mint: mint_x },
                500,
                EntryKind::PositionWithdrawal { position: POSITION }
            ),
        ]
    );
    assert_eq!(bundle.activities(), []);
    assert!(bundle.ownership().unknown_creations().contains(&POSITION));
    assert_eq!(
        bundle.ownership().diagnostics(),
        &[LifetimeDiagnostic::MissingCreation {
            position: POSITION,
            signature
        }]
    );
    assert_eq!(replay.finish().lifetimes, []);
}

/// The wallet withdraws 500 lamports of wrapped SOL from position 11, whose creation the replay
/// never saw, into a wrapped-SOL account the transaction creates for it and closes again, so the
/// account has no balance before or after. Its initialisation names the wallet as owner: the
/// withdrawal is the wallet's.
#[test]
fn books_a_withdrawal_into_an_ephemeral_wrapped_sol_account_as_the_wallets() {
    let source = ephemeral_withdrawal();
    let bundle = PositionLifetimes::new(context())
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    let entries: Vec<_> = bundle
        .entries()
        .iter()
        .map(|entry| (entry.asset, entry.amount, entry.kind))
        .collect();
    let wrapped_sol = Asset::Token { mint: WSOL_MINT };
    assert_eq!(
        entries,
        [
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (
                wrapped_sol,
                500,
                EntryKind::PositionWithdrawal { position: POSITION }
            ),
            (Asset::Sol, 500, EntryKind::Unwrap),
            (wrapped_sol, -500, EntryKind::Unwrap),
        ]
    );
    assert!(bundle.ownership().unknown_creations().contains(&POSITION));
}

/// The withdrawal of the test above: create and initialise the account for the wallet, withdraw
/// into it, then close it to the wallet.
#[expect(
    clippy::indexing_slicing,
    reason = "the remove_liquidity layout has nine known accounts"
)]
fn ephemeral_withdrawal() -> binsight_ledger::positions::PositionTransaction {
    let (ephemeral, reserve_x, reserve_y) = (book::address(3), book::address(5), book::address(6));
    let mut source = source(1, 10);
    source.transaction.native_balances[0].post.0 = 995_500;
    let mut create = 0_u32.to_le_bytes().to_vec();
    create.extend(2_039_280_u64.to_le_bytes());
    create.extend(165_u64.to_le_bytes());
    create.extend(TOKEN_PROGRAM.as_bytes());
    let mut accounts = vec![book::address(0); 9];
    accounts[0] = POSITION;
    accounts[1] = POOL;
    accounts[7] = WSOL_MINT;
    accounts[8] = book::address(8);
    let mut pay = vec![3];
    pay.extend(500_u64.to_le_bytes());
    let nodes = [
        (
            0,
            None,
            1,
            book::instruction(SYSTEM_PROGRAM, vec![WALLET, ephemeral], create),
        ),
        (
            1,
            None,
            1,
            book::instruction(TOKEN_PROGRAM, vec![ephemeral, WSOL_MINT, WALLET], vec![1]),
        ),
        (
            2,
            None,
            1,
            book::instruction(
                PROGRAM_ID,
                accounts,
                REMOVE_LIQUIDITY.to_be_bytes().to_vec(),
            ),
        ),
        (
            2,
            Some(0),
            2,
            book::instruction(TOKEN_PROGRAM, vec![reserve_x, ephemeral, POOL], pay),
        ),
        (
            2,
            Some(1),
            2,
            book::instruction(PROGRAM_ID, vec![EVENT_AUTHORITY], EVENT_IX_TAG.to_vec()),
        ),
        (
            3,
            None,
            1,
            book::instruction(TOKEN_PROGRAM, vec![ephemeral, WALLET, WALLET], vec![9]),
        ),
    ];
    for (top, inner, height, mut node) in nodes {
        node.position = InstructionPosition { top, inner };
        node.stack_height = Some(height);
        source.transaction.instructions.push(node);
    }
    let mut reserve = book::token(reserve_x, POOL, WSOL_MINT, 500, 0);
    reserve.decimals = binsight_core::units::Decimals(9);
    source.transaction.token_balances = vec![
        reserve,
        book::token(reserve_y, POOL, book::address(8), 0, 0),
    ];
    source
        .transaction
        .native_balances
        .push(book::native(ephemeral, 0, 0));
    source.activity.movements.push(PositionMovement {
        at: InstructionPosition {
            top: 2,
            inner: Some(1),
        },
        position: POSITION,
        pool: POOL,
        kind: MovementKind::Withdrawal,
        x: RawTokenAmount(500),
        y: RawTokenAmount(0),
        price_bin: Some(0),
    });
    source
}
