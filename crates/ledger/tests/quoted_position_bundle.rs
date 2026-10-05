//! Synthetic raw quotations bind the sealed book to its transaction bin, without FX or facts.
#[path = "common/lifetimes.rs"]
mod common;
#[path = "common/normalization.rs"]
mod normalization;

use binsight_core::units::{Decimals, RawTokenAmount};
use binsight_dlmm::math::{BinMathError, Q64x64, price_from_bin};
use binsight_ledger::book::WalletContext;
use binsight_ledger::facts::{FlowValuation, PhysicalSide, PoolFacts, TokenFacts, TokenKind};
use binsight_ledger::positions::{
    BookedPositionTransaction, PositionLifetimes, PositionTransaction, TransactionOrderProof,
    ValuationError,
};
use binsight_solana::{programs::TokenProgram, well_known};
use common::*;
use normalization::{deposit, replay};

// The stable kind is injected synthetic metadata, not a canonical stablecoin mint claim.
fn pool(side: PhysicalSide) -> PoolFacts {
    let token = |mint, kind| TokenFacts {
        mint: book::address(mint),
        symbol: None,
        name: None,
        decimals: Decimals(6),
        kind,
    };
    PoolFacts {
        address: POOL,
        bin_step: 100,
        base: token(
            9,
            if side == PhysicalSide::X {
                TokenKind::Usdc
            } else {
                TokenKind::Other
            },
        ),
        quote: token(
            8,
            if side == PhysicalSide::Y {
                TokenKind::Usdc
            } else {
                TokenKind::Other
            },
        ),
    }
}

#[expect(
    clippy::unwrap_used,
    reason = "these synthetic sources book successfully"
)]
fn booked(source: PositionTransaction) -> BookedPositionTransaction {
    replay()
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap()
}

#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the synthetic deposit has one movement and three token balances"
)]
fn with_y(mut source: PositionTransaction, amount: u64) -> PositionTransaction {
    source.activity.movements.first_mut().unwrap().y = RawTokenAmount(u128::from(amount));
    source.transaction.token_balances[2].post = RawTokenAmount(u128::from(amount));
    source
        .transaction
        .native_balances
        .push(book::native(book::address(5), 200, 200));
    source.transaction.token_balances.push(book::token(
        book::address(5),
        WALLET,
        book::address(8),
        u128::from(amount),
        0,
    ));
    let mut bytes = vec![12];
    bytes.extend(amount.to_le_bytes());
    bytes.push(6);
    let mut transfer = book::instruction(
        well_known::TOKEN_PROGRAM,
        vec![book::address(5), book::address(8), book::address(4), WALLET],
        bytes,
    );
    transfer.position.inner = Some(1);
    transfer.stack_height = Some(2);
    source.transaction.instructions.push(transfer);
    source
}

#[test]
fn values_each_physical_side_at_its_own_transaction_bin() {
    // Python bigint oracle for bin1/step100: P=18631211514446647132.
    // floor(950*P/2^64)+17=976; 950+floor(17*2^64/P)=966.
    let mut source = with_y(deposit(), 17);
    source.activity.movements.first_mut().unwrap().price_bin = Some(1);
    for (side, amount) in [(PhysicalSide::X, 966), (PhysicalSide::Y, 976)] {
        let bundle = booked(source.clone());
        let entries = bundle.entries().to_vec();
        let quoted = bundle.quote_pool(pool(side)).unwrap();
        let movement = quoted.movements().first().unwrap();
        assert_eq!(movement.quoted().amount, RawTokenAmount(amount));
        assert_eq!(movement.quoted().valuation, FlowValuation::Complete);
        assert_eq!(movement.movement().price_bin, Some(1));
        assert_eq!(movement.movement().x, RawTokenAmount(950));
        assert_eq!(movement.movement().y, RawTokenAmount(17));
        assert_eq!(
            movement.position().opened_by,
            quoted
                .booked()
                .ownership()
                .position_for(movement.source())
                .unwrap()
                .opened_by
        );
        assert_eq!(quoted.booked().entries(), entries);
        assert_eq!(quoted.pool(), &pool(side));
        assert_eq!(quoted.convention().side(), side);
        assert_ne!(movement.quoted().amount, RawTokenAmount(967));
    }
    assert_eq!(
        price_from_bin(1, 100).unwrap(),
        Q64x64(18_631_211_514_446_647_132)
    );
}

#[test]
fn keeps_missing_price_coverage_separate_from_a_selected_zero() {
    let mut source = deposit();
    source.activity.movements.first_mut().unwrap().price_bin = None;
    let bundle = booked(source);
    let x = bundle.clone().quote_pool(pool(PhysicalSide::X)).unwrap();
    assert_eq!(x.movements()[0].quoted().amount, RawTokenAmount(950));
    assert_eq!(x.movements()[0].quoted().valuation, FlowValuation::Complete);
    let y = bundle.quote_pool(pool(PhysicalSide::Y)).unwrap();
    assert_eq!(y.movements()[0].quoted().amount, RawTokenAmount(0));
    assert_eq!(
        y.movements()[0].quoted().valuation,
        FlowValuation::QuoteOnly
    );
}

#[test]
fn validates_gross_mint_evidence_even_when_a_deposit_is_fully_taxed() {
    let mut source = deposit();
    source.transaction.token_balances[1].post = RawTokenAmount(0);
    source.transaction.instructions[1]
        .data
        .0
        .splice(11..19, 1_000_u64.to_le_bytes());
    let bundle = booked(source);
    let mut wrong = pool(PhysicalSide::X);
    wrong.base.mint = book::address(90);
    assert_eq!(
        bundle.clone().quote_pool(wrong),
        Err(ValuationError::MetadataMismatch {
            mint: book::address(90)
        })
    );
    let quoted = bundle.quote_pool(pool(PhysicalSide::X)).unwrap();
    assert_eq!(quoted.movements()[0].movement().x, RawTokenAmount(0));
    assert_eq!(quoted.movements()[0].quoted().amount, RawTokenAmount(0));
    assert_eq!(
        quoted.movements()[0].quoted().valuation,
        FlowValuation::Complete
    );
    assert_eq!(
        quoted.booked().source().activity.movements[0].x,
        RawTokenAmount(1_000)
    );
    assert_eq!(
        quoted
            .booked()
            .entries()
            .iter()
            .find(|entry| entry.kind == binsight_ledger::book::EntryKind::TransferFee)
            .unwrap()
            .amount,
        -1_000
    );
}

#[test]
fn rejects_pool_mint_decimals_and_source_program_contradictions() {
    let bundle = booked(deposit());
    let mut wrong = pool(PhysicalSide::Y);
    wrong.address = FOREIGN;
    assert_eq!(
        bundle.clone().quote_pool(wrong),
        Err(ValuationError::PoolMismatch {
            expected: FOREIGN,
            observed: POOL
        })
    );
    for change in 0..2 {
        let mut wrong = pool(PhysicalSide::Y);
        if change == 0 {
            wrong.base.mint = book::address(90);
        } else {
            wrong.base.decimals = Decimals(7);
        }
        assert!(matches!(
            bundle.clone().quote_pool(wrong),
            Err(ValuationError::MetadataMismatch { .. })
        ));
    }
    let mut source = deposit();
    let mut extra = book::token(book::address(20), FOREIGN, book::address(9), 0, 0);
    extra.program = TokenProgram::Token;
    source.transaction.token_balances.push(extra);
    assert_eq!(
        booked(source).quote_pool(pool(PhysicalSide::Y)),
        Err(ValuationError::MetadataMismatch {
            mint: book::address(9)
        })
    );
}

#[test]
fn refuses_invalid_bins_and_unsupported_quotes_without_partial_publication() {
    let mut source = deposit();
    source.activity.movements.first_mut().unwrap().price_bin = Some(524_288);
    assert_eq!(
        booked(source).quote_pool(pool(PhysicalSide::Y)),
        Err(ValuationError::Price(BinMathError::ExponentOutOfRange))
    );
    let mut unsupported = pool(PhysicalSide::Y);
    unsupported.quote.kind = TokenKind::Other;
    assert_eq!(
        booked(deposit()).quote_pool(unsupported),
        Err(ValuationError::UnsupportedQuote)
    );
}

#[test]
fn retains_missing_dates_and_wallet_order_tags_without_creating_chain_order() {
    let mut replay = PositionLifetimes::new(context());
    let mut opening = opening(1, 10);
    opening.order = Some(TransactionOrderProof::WalletOrdinal { rank: 2 });
    opening.transaction.transaction_index = None;
    replay
        .book_and_apply(opening, WalletContext::new(WALLET))
        .unwrap();
    let mut source = deposit();
    source.order = Some(TransactionOrderProof::WalletOrdinal { rank: 1 });
    source.transaction.transaction_index = None;
    source.transaction.block_time = None;
    let quoted = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap()
        .quote_pool(pool(PhysicalSide::Y))
        .unwrap();
    assert_eq!(
        quoted.booked().source().order,
        Some(TransactionOrderProof::WalletOrdinal { rank: 1 })
    );
    assert_eq!(quoted.booked().source().transaction.transaction_index, None);
    assert_eq!(quoted.booked().source().transaction.block_time, None);
    assert_ne!(quoted.booked().ownership().diagnostics(), []);
    assert_eq!(quoted.movements().len(), 1);
}

#[test]
fn retains_third_mint_rewards_and_refuses_a_different_owned_reward_pool() {
    let mut source = deposit();
    source.activity.reward_claims.push(reward(1, 123));
    source
        .transaction
        .native_balances
        .push(book::native(book::address(6), 200, 200));
    source.transaction.token_balances.push(book::token(
        book::address(6),
        WALLET,
        book::address(15),
        0,
        123,
    ));
    let quoted = booked(source.clone())
        .quote_pool(pool(PhysicalSide::Y))
        .unwrap();
    assert_eq!(quoted.movements().len(), 1);
    assert_eq!(
        quoted.booked().source().activity.reward_claims,
        source.activity.reward_claims
    );
    assert_eq!(quoted.booked().activities().len(), 2);
    let mut replay = PositionLifetimes::new(context());
    let mut opened = opening(1, 10);
    opened
        .activity
        .lifecycle
        .push(binsight_dlmm::activity::LifecycleFact::Created {
            at: at(1),
            position: book::address(13),
            pool: book::address(14),
            owner: WALLET,
        });
    replay
        .book_and_apply(opened, WalletContext::new(WALLET))
        .unwrap();
    source.activity.reward_claims[0].position = book::address(13);
    source.activity.reward_claims[0].pool = book::address(14);
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(
        bundle.quote_pool(pool(PhysicalSide::Y)),
        Err(ValuationError::PoolMismatch {
            expected: POOL,
            observed: book::address(14)
        })
    );
}

#[test]
fn refuses_a_sol_kind_without_canonical_wrapped_sol_metadata() {
    let mut wrong = pool(PhysicalSide::X);
    wrong.base.kind = TokenKind::Sol;
    assert_eq!(
        booked(deposit()).quote_pool(wrong),
        Err(ValuationError::MetadataMismatch {
            mint: book::address(9)
        })
    );
}

#[test]
fn matches_bigint_floors_for_both_orientations_across_transaction_bins() {
    // Expected values use arbitrary-precision integers and the pinned program Q64 pow.
    for (bin, y, quote_x, quote_y) in [
        (-1, 17, 967, 957),
        (-1, 33, 983, 973),
        (0, 17, 967, 967),
        (0, 33, 983, 983),
        (1, 17, 966, 976),
        (1, 33, 982, 992),
    ] {
        let mut source = with_y(deposit(), y);
        source.activity.movements.first_mut().unwrap().price_bin = Some(bin);
        let bundle = booked(source);
        for (side, expected) in [(PhysicalSide::X, quote_x), (PhysicalSide::Y, quote_y)] {
            let quoted = bundle.clone().quote_pool(pool(side)).unwrap();
            assert_eq!(
                quoted.movements()[0].quoted().amount,
                RawTokenAmount(expected)
            );
        }
    }
}

#[test]
fn accepts_canonical_wrapped_sol_and_checks_its_decimals_and_program() {
    let mut source = deposit();
    for balance in &mut source.transaction.token_balances {
        if balance.mint == book::address(9) {
            balance.mint = well_known::WSOL_MINT;
            balance.decimals = Decimals(9);
            balance.program = TokenProgram::Token;
        }
    }
    source.transaction.token_balances[1].post = RawTokenAmount(1_000);
    source.transaction.native_balances[1].pre.0 = 1_200;
    source.transaction.instructions[0].accounts[7] = well_known::WSOL_MINT;
    let transfer = &mut source.transaction.instructions[1];
    transfer.program = well_known::TOKEN_PROGRAM;
    transfer.accounts[1] = well_known::WSOL_MINT;
    transfer.data.0 = vec![12];
    transfer.data.0.extend(1_000_u64.to_le_bytes());
    transfer.data.0.push(9);
    let mut facts = pool(PhysicalSide::X);
    facts.base.mint = well_known::WSOL_MINT;
    facts.base.kind = TokenKind::Sol;
    facts.base.decimals = Decimals(9);
    let bundle = booked(source.clone());
    assert_eq!(
        bundle
            .clone()
            .quote_pool(facts.clone())
            .unwrap()
            .movements()[0]
            .quoted()
            .amount,
        RawTokenAmount(1_000)
    );
    let mut wrong = facts.clone();
    wrong.base.decimals = Decimals(6);
    assert_eq!(
        bundle.quote_pool(wrong),
        Err(ValuationError::MetadataMismatch {
            mint: well_known::WSOL_MINT
        })
    );
    let mut extra = book::token(book::address(20), FOREIGN, well_known::WSOL_MINT, 0, 0);
    extra.decimals = Decimals(9);
    extra.program = TokenProgram::Token2022;
    source.transaction.token_balances.push(extra);
    assert_eq!(
        booked(source).quote_pool(facts),
        Err(ValuationError::MetadataMismatch {
            mint: well_known::WSOL_MINT
        })
    );
}

#[test]
fn refuses_even_a_zero_owned_movement_of_another_pool_instead_of_dropping_it() {
    let mut replay = PositionLifetimes::new(context());
    let mut opened = opening(1, 10);
    opened
        .activity
        .lifecycle
        .push(binsight_dlmm::activity::LifecycleFact::Created {
            at: at(1),
            position: book::address(13),
            pool: book::address(14),
            owner: WALLET,
        });
    replay
        .book_and_apply(opened, WalletContext::new(WALLET))
        .unwrap();
    let mut source = deposit();
    let mut other = movement(1, 0, 0);
    other.position = book::address(13);
    other.pool = book::address(14);
    source.activity.movements.push(other);
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(bundle.activities().len(), 2);
    assert_eq!(
        bundle.quote_pool(pool(PhysicalSide::Y)),
        Err(ValuationError::PoolMismatch {
            expected: POOL,
            observed: book::address(14),
        })
    );
}
