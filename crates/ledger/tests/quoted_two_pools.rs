//! A transaction that moves positions in two pools is valued movement by movement, each in the
//! quote of its own pool: one in USDC, the other in SOL.
#[path = "common/lifetimes.rs"]
mod common;
#[path = "common/normalization.rs"]
#[allow(dead_code, reason = "this test uses only the deposit builder")]
mod normalization;

use binsight_core::units::{Decimals, RawTokenAmount};
use binsight_ledger::book::WalletContext;
use binsight_ledger::facts::{PoolFacts, QuoteAsset, TokenFacts, TokenKind};
use binsight_ledger::positions::{PositionLifetimes, PositionTransaction, ValuationError};
use binsight_solana::Address;
use binsight_solana::well_known::WSOL_MINT;
use common::*;
use normalization::deposit;

/// Pool 12 of the deposit: token 9 against USDC (token 8).
fn usdc_pool() -> PoolFacts {
    PoolFacts {
        address: POOL,
        bin_step: 100,
        base: token(book::address(9), TokenKind::Other, 6),
        quote: token(book::address(8), TokenKind::Usdc, 6),
    }
}

/// Pool 14: token 16 against wrapped SOL.
fn sol_pool() -> PoolFacts {
    PoolFacts {
        address: book::address(14),
        bin_step: 100,
        base: token(book::address(16), TokenKind::Other, 6),
        quote: token(WSOL_MINT, TokenKind::Sol, 9),
    }
}

fn token(mint: Address, kind: TokenKind, decimals: u8) -> TokenFacts {
    TokenFacts {
        mint,
        symbol: None,
        name: None,
        decimals: Decimals(decimals),
        kind,
    }
}

/// A deposit of 950 X in USDC pool 12 at bin 0, and a withdrawal of (500 X, 300 lamports) in
/// SOL pool 14 at bin 1 (P = 1.01 minus a fraction of a unit), in one transaction: 950 micro-USDC
/// and floor(500 P) + 300 = 804 lamports, each in the quote of its own pool.
#[test]
fn values_a_transaction_that_moves_positions_in_two_pools_each_in_its_own_quote() {
    let other_pool = book::address(14);
    let mut replay = PositionLifetimes::new(context());
    let mut opened = opening(1, 10);
    opened
        .activity
        .lifecycle
        .push(binsight_dlmm::activity::LifecycleFact::Created {
            at: at(1),
            position: book::address(13),
            pool: other_pool,
            owner: WALLET,
        });
    replay
        .book_and_apply(opened, WalletContext::new(WALLET))
        .unwrap();
    let source = with_withdrawal_in_another_pool(deposit());
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    let (first, other) = (usdc_pool(), sol_pool());
    assert_eq!(
        bundle.clone().quote_pools(std::slice::from_ref(&first)),
        Err(ValuationError::MissingPool { pool: other_pool })
    );
    let quoted = bundle.quote_pools(&[first, other]).unwrap();
    let values: Vec<_> = quoted
        .movements()
        .iter()
        .map(|movement| {
            (
                movement.movement().pool,
                movement.convention().asset(),
                movement.quoted().amount,
            )
        })
        .collect();
    assert_eq!(
        values,
        [
            (POOL, QuoteAsset::Usdc, RawTokenAmount(950)),
            (other_pool, QuoteAsset::Sol, RawTokenAmount(804))
        ]
    );
}

/// Adds to `source` a withdrawal of (500, 300) from position 13 of pool 14, whose mints are
/// 16 and wrapped SOL, paid from the pool's reserves into two token accounts of the wallet.
#[expect(
    clippy::indexing_slicing,
    reason = "the remove_liquidity layout has nine known accounts"
)]
fn with_withdrawal_in_another_pool(mut source: PositionTransaction) -> PositionTransaction {
    let (position, other_pool) = (book::address(13), book::address(14));
    let (mint_x, mint_y) = (book::address(16), WSOL_MINT);
    let mut accounts = vec![book::address(0); 9];
    accounts[0] = position;
    accounts[1] = other_pool;
    accounts[7] = mint_x;
    accounts[8] = mint_y;
    let mut remove = book::instruction(
        binsight_dlmm::program::PROGRAM_ID,
        accounts,
        0x5055_d148_18ce_b16c_u64.to_be_bytes().to_vec(),
    );
    remove.position.top = 1;
    source.transaction.instructions.push(remove);
    for (account, owner, mint, pre, post) in [
        (book::address(30), WALLET, mint_x, 0, 500),
        (book::address(31), WALLET, mint_y, 0, 300),
        (book::address(32), other_pool, mint_x, 500, 0),
        (book::address(33), other_pool, mint_y, 300, 0),
    ] {
        let mut balance = book::token(account, owner, mint, pre, post);
        if mint == WSOL_MINT {
            balance.decimals = Decimals(9);
        }
        source.transaction.token_balances.push(balance);
    }
    // A wrapped-SOL account holds its tokens as lamports, above its rent of 200.
    source.transaction.native_balances.extend([
        book::native(book::address(30), 200, 200),
        book::native(book::address(31), 200, 500),
    ]);
    let mut withdrawal = movement(1, 500, 300);
    withdrawal.position = position;
    withdrawal.pool = other_pool;
    withdrawal.kind = binsight_dlmm::activity::MovementKind::Withdrawal;
    withdrawal.price_bin = Some(1);
    source.activity.movements.push(withdrawal);
    source
}
