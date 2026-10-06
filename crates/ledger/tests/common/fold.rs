//! Synthetic wallet transactions for the position fold: each names its pools' tokens the way a
//! DLMM instruction does, so it books, and carries the activity a test gives it.
#![allow(
    dead_code,
    reason = "each test binary uses a different subset of these builders"
)]

#[path = "book.rs"]
pub(crate) mod book;

use std::collections::{BTreeMap, BTreeSet};

use binsight_core::units::{Decimals, RawTokenAmount};
use binsight_dlmm::activity::{LifecycleFact, MovementKind, PositionMovement, TxActivity};
use binsight_dlmm::program::PROGRAM_ID;
use binsight_ledger::book::WalletContext;
use binsight_ledger::facts::{ClosedPositionFacts, PoolFacts, SolUsdRates, TokenFacts, TokenKind};
use binsight_ledger::positions::PositionFold;
use binsight_ledger::report::closed::ClosedValuation;
use binsight_solana::transaction::{InstructionPosition, TransactionView};
use binsight_solana::well_known::{USDC_MINT, USDT_MINT, WSOL_MINT};
use binsight_solana::{Address, Signature};
use jiff::Timestamp;

pub(crate) const WALLET: Address = Address::from_bytes([1; 32]);
pub(crate) const OTHER_OWNER: Address = Address::from_bytes([2; 32]);
pub(crate) const POSITION: Address = Address::from_bytes([11; 32]);
pub(crate) const SECOND_POSITION: Address = Address::from_bytes([13; 32]);
/// A pool of a token and SOL.
pub(crate) const SOL_POOL: Address = Address::from_bytes([12; 32]);
/// A pool of a token and USDC.
pub(crate) const USDC_POOL: Address = Address::from_bytes([14; 32]);
/// A pool of two tokens, neither SOL nor a dollar.
pub(crate) const TOKEN_POOL: Address = Address::from_bytes([15; 32]);
/// A pool of USDC (X) and USDT (Y), with a bin step of 1.
pub(crate) const STABLE_POOL: Address = Address::from_bytes([16; 32]);
/// The token every pool trades.
pub(crate) const TOKEN: Address = Address::from_bytes([9; 32]);
/// The second token of the token pool.
pub(crate) const OTHER_TOKEN: Address = Address::from_bytes([8; 32]);

/// The `remove_liquidity` discriminator, which names a pool's two mints.
const REMOVE_LIQUIDITY: u64 = 0x5055_d148_18ce_b16c;

pub(crate) fn time(seconds: i64) -> Timestamp {
    Timestamp::from_second(seconds).unwrap_or(Timestamp::UNIX_EPOCH)
}

/// A successful transaction of the wallet at `slot`, dated `slot` seconds after the epoch.
pub(crate) fn transaction(seed: u8, slot: u64) -> TransactionView {
    let mut tx = book::transaction(1_000_000, 995_000);
    tx.signature = Signature::from_bytes([seed; 64]);
    tx.slot = slot;
    tx.block_time = i64::try_from(slot).ok().map(time);
    tx
}

/// The two mints of `pool`, X first.
pub(crate) fn mints(pool: Address) -> (Address, Address) {
    match pool {
        USDC_POOL => (TOKEN, USDC_MINT),
        STABLE_POOL => (USDC_MINT, USDT_MINT),
        TOKEN_POOL => (TOKEN, OTHER_TOKEN),
        _ => (TOKEN, WSOL_MINT),
    }
}

/// Makes `tx` name the mints of `pool` in a `remove_liquidity` call at `top`, with the pool's
/// two reserves among its token accounts.
#[expect(
    clippy::indexing_slicing,
    reason = "the remove_liquidity layout has nine known accounts"
)]
pub(crate) fn names_pool_tokens(tx: &mut TransactionView, pool: Address, top: u16) {
    let (mint_x, mint_y) = mints(pool);
    let mut accounts = vec![book::address(0); 9];
    accounts[1] = pool;
    accounts[7] = mint_x;
    accounts[8] = mint_y;
    let mut call = book::instruction(
        PROGRAM_ID,
        accounts,
        REMOVE_LIQUIDITY.to_be_bytes().to_vec(),
    );
    call.position.top = top;
    tx.instructions.push(call);
    let [reserve_x, reserve_y] = [100, 101].map(|seed: u8| {
        let mut bytes = *pool.as_bytes();
        bytes[0] = seed;
        Address::from_bytes(bytes)
    });
    tx.token_balances
        .push(book::token(reserve_x, pool, mint_x, 0, 0));
    tx.token_balances
        .push(book::token(reserve_y, pool, mint_y, 0, 0));
}

pub(crate) fn at(top: u16) -> InstructionPosition {
    InstructionPosition { top, inner: None }
}

pub(crate) fn movement(
    position: Address,
    pool: Address,
    kind: MovementKind,
    (x, y): (u128, u128),
    price_bin: Option<i32>,
) -> PositionMovement {
    PositionMovement {
        at: at(0),
        position,
        pool,
        kind,
        x: RawTokenAmount(x),
        y: RawTokenAmount(y),
        price_bin,
    }
}

pub(crate) fn created(position: Address, pool: Address, owner: Address) -> LifecycleFact {
    LifecycleFact::Created {
        at: at(0),
        position,
        pool,
        owner,
    }
}

pub(crate) fn closed(position: Address, owner: Address) -> LifecycleFact {
    LifecycleFact::Closed {
        at: at(0),
        position,
        owner,
    }
}

/// A transaction at `slot` with `activity`, naming the tokens of every pool it moves.
pub(crate) fn step(seed: u8, slot: u64, activity: &TxActivity) -> TransactionView {
    let mut tx = transaction(seed, slot);
    let pools: BTreeSet<Address> = activity.movements.iter().map(|m| m.pool).collect();
    for (top, pool) in (0_u16..).zip(pools) {
        names_pool_tokens(&mut tx, pool, top);
    }
    tx
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

/// The facts of the synthetic pools: a bin step of 100, but 1 for the stable pool.
pub(crate) fn pools() -> BTreeMap<Address, PoolFacts> {
    let traded = token(TOKEN, TokenKind::Other, 6);
    [
        (
            SOL_POOL,
            100,
            traded.clone(),
            token(WSOL_MINT, TokenKind::Sol, 9),
        ),
        (
            USDC_POOL,
            100,
            traded.clone(),
            token(USDC_MINT, TokenKind::Usdc, 6),
        ),
        (
            TOKEN_POOL,
            100,
            traded,
            token(OTHER_TOKEN, TokenKind::Other, 6),
        ),
        (
            STABLE_POOL,
            1,
            token(USDC_MINT, TokenKind::Usdc, 6),
            token(USDT_MINT, TokenKind::Usdt, 6),
        ),
    ]
    .into_iter()
    .map(|(address, bin_step, base, quote)| {
        let pool = PoolFacts {
            address,
            bin_step,
            base,
            quote,
        };
        (address, pool)
    })
    .collect()
}

pub(crate) fn fold() -> PositionFold {
    PositionFold::new(WalletContext::new(WALLET))
}

/// Folds `steps`, one transaction each, from slot 1 on; every step must fold.
#[expect(clippy::unwrap_used, reason = "these synthetic histories fold")]
pub(crate) fn run(fold: &mut PositionFold, steps: &[TxActivity]) -> Vec<ClosedPositionFacts> {
    let pools = pools();
    let mut closed = Vec::new();
    for (seed, activity) in (1_u8..).zip(steps) {
        let tx = step(seed, u64::from(seed), activity);
        closed.extend(fold.book(&tx, activity, &pools).unwrap().closed);
    }
    closed
}

pub(crate) fn lifecycle(facts: Vec<LifecycleFact>) -> TxActivity {
    TxActivity {
        lifecycle: facts,
        ..TxActivity::default()
    }
}

pub(crate) fn moves(movements: Vec<PositionMovement>) -> TxActivity {
    TxActivity {
        movements,
        ..TxActivity::default()
    }
}

/// A life of `POSITION` in `pool`: created, then `middle`, then closed.
pub(crate) fn life(pool: Address, middle: Vec<TxActivity>) -> Vec<ClosedPositionFacts> {
    let mut steps = vec![lifecycle(vec![created(POSITION, pool, WALLET)])];
    steps.extend(middle);
    steps.push(lifecycle(vec![closed(POSITION, WALLET)]));
    run(&mut fold(), &steps)
}

#[expect(clippy::unwrap_used, reason = "the synthetic pools have facts")]
pub(crate) fn valued(position: &ClosedPositionFacts) -> ClosedValuation {
    let pool = pools().remove(&position.pool).unwrap();
    ClosedValuation::of(position, &pool, &SolUsdRates::default()).unwrap()
}
