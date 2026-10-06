//! Whole lives of public mainnet positions, folded into their facts and liquidity PnL.
//!
//! Every expected value was recomputed apart from the code with exact rationals: a movement is
//! worth `x·1.01^bin + y` lamports (bin step 100, SOL in Y), floored once per movement.
#[path = "common/cases.rs"]
mod cases;

use binsight_core::exactness::Exactness;
use binsight_dlmm::pool_tokens::PoolTokens;
use binsight_ledger::book::{Asset, EntryKind, WalletContext};
use binsight_ledger::facts::{
    ClosedPositionFacts, PoolFacts, PositionHistory, QuoteUnits, SolUsdRates, TokenFacts, TokenKind,
};
use binsight_ledger::positions::{FoldDiagnostics, FoldedTransaction, PositionFold};
use binsight_ledger::report::closed::{ClosedValuation, Outcome, lp_pnl};
use binsight_solana::Address;
use binsight_solana::well_known::USDC_MINT;
use cases::{Case, case};

/// Folds every transaction of `case` from the point of view of `wallet`.
#[expect(clippy::unwrap_used, reason = "every public case folds")]
fn fold(case: &Case, wallet: Address) -> (PositionFold, Vec<FoldedTransaction>) {
    let mut fold = PositionFold::new(WalletContext::new(wallet));
    let folded = case
        .transactions
        .iter()
        .map(|(tx, activity)| fold.book(tx, activity, &case.pools).unwrap())
        .collect();
    (fold, folded)
}

/// The one life `case`'s wallet closed.
#[expect(clippy::unwrap_used, reason = "the case closes exactly one life")]
fn closed_life(case: &Case) -> ClosedPositionFacts {
    let (fold, folded) = fold(case, case.perspective);
    assert_eq!(fold.open().count(), 0);
    let mut closed: Vec<_> = folded.into_iter().flat_map(|step| step.closed).collect();
    assert_eq!(closed.len(), 1);
    closed.pop().unwrap()
}

#[expect(clippy::unwrap_used, reason = "the case's pool facts are captured")]
fn valued(case: &Case, life: &ClosedPositionFacts) -> ClosedValuation {
    let pool = case.pools.get(&life.pool).cloned().unwrap();
    ClosedValuation::of(life, &pool, &SolUsdRates::default()).unwrap()
}

/// Create, deposit 2.100276886 SOL at bin −520, then withdraw 2.100280970 SOL and claim
/// 203,206,129 raw tokens plus 1,086,825 lamports of fees at bin −509, and close. The token fee
/// is worth floor(203,206,129 × 1.01^−509) = 1,283,386 lamports.
#[test]
fn folds_a_whole_life_in_a_sol_pool_into_its_liquidity_pnl() {
    let case = case("position-life-sol");
    let life = closed_life(&case);
    assert_eq!(
        life.id.to_string(),
        "2yVmeEM1xUEr575N8pkCTmBrgBVq3yLRcKLNdHzH3VJY-7MBppyXPpt3Cr6bkNYq57dtSdehUbqKLpRPmvJhHo3eNNPYiTCMtkjxe5TaVCWp5z2Vu2KD5yPYt3G1ymGER6dz"
    );
    assert_eq!(life.wallet, case.perspective);
    assert_eq!(life.opened_at.to_string(), "2026-10-04T11:18:32Z");
    assert_eq!(life.closed_at.to_string(), "2026-10-04T11:32:29Z");
    assert_eq!(life.invested, QuoteUnits(2_100_276_886));
    assert_eq!(life.withdrawn, QuoteUnits(2_100_280_970));
    assert_eq!(life.claimed_fees, QuoteUnits(1_086_825 + 1_283_386));
    assert!(life.unpriced_movements.is_none());
    assert_eq!(lp_pnl(&life), Ok(QuoteUnits(2_374_295)));
    let valued = valued(&case, &life);
    assert_eq!(valued.outcome, Outcome::Win);
    assert_eq!(valued.native_pnl.exactness(), Exactness::Complete);
    assert!(!valued.is_shell);
}

/// A deposit of 19,999,999,999 raw tokens, worth 6,243,516,489 lamports at bin −117, whose
/// Token-2022 fee withholds 200,000,000: the fee counts in what the position invested, and stays
/// a transfer-fee entry of the book too. A rebalance then
/// withdraws 19,799,999,996 tokens (6,181,081,323) in one transaction and re-deposits
/// 9,609,765,636 tokens (2,999,936,510) and 3,107,167,893 lamports in the next one. Fees of
/// 90,778,216 + 66,349,715 (bin −121) and 11,906,651 + 79,582,057 (bin −105) are claimed, and
/// 6,152,189,699 lamports withdrawn at the close.
#[test]
fn counts_rebalance_halves_whole_and_a_deposit_with_its_withheld_transfer_fee() {
    let case = case("position-life-rebalanced");
    let (_, folded) = fold(&case, case.perspective);
    let first = folded.first().map(|step| step.entries.as_slice());
    assert!(first.is_some_and(|entries| {
        entries
            .iter()
            .any(|entry| entry.kind == EntryKind::TransferFee && entry.amount == -200_000_000)
    }));
    let life = closed_life(&case);
    assert_eq!(
        life.invested,
        QuoteUnits(6_243_516_489 + 2_999_936_510 + 3_107_167_893)
    );
    assert_eq!(life.withdrawn, QuoteUnits(6_181_081_323 + 6_152_189_699));
    assert_eq!(
        life.claimed_fees,
        QuoteUnits(90_778_216 + 66_349_715 + 11_906_651 + 79_582_057)
    );
    assert_eq!(lp_pnl(&life), Ok(QuoteUnits(231_266_769)));
    assert_eq!(valued(&case, &life).outcome, Outcome::Win);
}

/// An automation signs every transaction of a position another wallet owns: 999,421,460
/// lamports deposited in three movements, 29,075 claimed, 999,388,834 withdrawn by a rebalance
/// before the close. The life is the owner's; the signer has none.
#[test]
fn gives_an_operated_position_to_the_owner_its_creation_names() {
    let case = case("position-life-operator");
    let life = closed_life(&case);
    assert_eq!(life.invested, QuoteUnits(999_421_460));
    assert_eq!(life.withdrawn, QuoteUnits(999_388_834));
    assert_eq!(life.claimed_fees, QuoteUnits(29_075));
    assert_eq!(lp_pnl(&life), Ok(QuoteUnits(-3_551)));
    assert_eq!(valued(&case, &life).outcome, Outcome::Loss);

    let operator = "HAWK3BVnwptKRFYfVoVGhBc2TYxpyG9jmAbkHeW9tyKE".parse();
    let (fold, folded) = fold(&case, operator.unwrap_or(case.perspective));
    assert!(folded.iter().all(|step| step.closed.is_empty()));
    assert_eq!(fold.open().count(), 0);
    assert_eq!(fold.diagnostics(), FoldDiagnostics::default());
}

/// A claim from June 2025 whose events carry no bin, of a position whose creation is not in
/// the history: 53,922 raw tokens and 625 micro-USDC of fees, and a farming reward in a third
/// token. The life starts at the claim; only the USDC counts, and both the token fee and the
/// reward stay unpriced.
#[test]
fn starts_a_life_at_a_claim_whose_creation_is_missing_and_keeps_what_has_no_price() {
    let mut case = case("claim-fee-v1-alone");
    let (tx, activity) = case.transactions.first().unwrap();
    let claim = activity.movements.first().unwrap();
    let mints = PoolTokens::of(tx).mints_of(tx, claim);
    let decimals = |mint| {
        tx.token_balances
            .iter()
            .find(|balance| balance.mint == mint)
            .unwrap()
            .decimals
    };
    let token = |mint: Address, kind| TokenFacts {
        mint,
        symbol: None,
        name: None,
        decimals: decimals(mint),
        kind,
    };
    let (x, y) = (mints.x.unwrap(), mints.y.unwrap());
    assert_eq!(y, USDC_MINT);
    // Without a bin the bin step prices nothing: the account was not captured with the claim.
    let pool = PoolFacts {
        address: claim.pool,
        bin_step: 1,
        base: token(x, TokenKind::Other),
        quote: token(y, TokenKind::Usdc),
    };
    case.pools.insert(claim.pool, pool);
    let (fold, folded) = fold(&case, case.perspective);
    assert!(folded.iter().all(|step| step.closed.is_empty()));
    let life = fold.open().next().unwrap();
    assert_eq!(life.id.opened_by, tx.signature);
    assert_eq!(life.flows.claimed_fees, QuoteUnits(625));
    assert_eq!(life.flows.unpriced_movements.fee_claims, 1);
    assert_eq!(life.flows.unpriced_rewards, 1);
    assert_eq!(life.flows.rewards, QuoteUnits(0));
    assert_eq!(life.history, PositionHistory::MissingCreation);
    assert_eq!(fold.diagnostics().missing_creations, 1);
    let entries = &folded.first().unwrap().entries;
    assert!(
        entries
            .iter()
            .any(|entry| entry.asset == Asset::Token { mint: USDC_MINT }
                && entry.amount == 625
                && entry.kind
                    == EntryKind::FeeClaim {
                        position: claim.position
                    })
    );
}

/// A bot claims, removes and closes a position, then a later instruction fails: the close
/// emitted its event, yet nothing happened. Only the fee is booked and no life closes.
#[test]
fn closes_no_life_in_a_failed_transaction() {
    let case = case("failed-close");
    let (fold, folded) = fold(&case, case.perspective);
    assert_eq!(fold.open().count(), 0);
    let kinds: Vec<_> = folded
        .iter()
        .flat_map(|step| step.entries.iter().map(|entry| entry.kind))
        .collect();
    assert_eq!(kinds, [EntryKind::FailedTxFee]);
    assert!(folded.iter().all(|step| step.closed.is_empty()));
}

/// The automation pays the rent of the owner's position account at its creation and takes it
/// back at the close: neither is the owner's, so no rent entry is booked for the owner, whether
/// the history holds the creation or starts after it.
#[test]
fn books_no_rent_an_automation_paid_for_the_owners_position() {
    let case = case("position-life-operator");
    let (_, folded) = fold(&case, case.perspective);
    let rent: Vec<_> = folded
        .iter()
        .flat_map(|step| step.entries.iter())
        .filter(|entry| entry.asset == Asset::Rent)
        .collect();
    assert_eq!(rent, Vec::<&binsight_ledger::book::LedgerEntry>::new());

    let mut without_creation = PositionFold::new(WalletContext::new(case.perspective));
    for (tx, activity) in case.transactions.iter().skip(1) {
        let step = without_creation.book(tx, activity, &case.pools).unwrap();
        assert!(step.entries.iter().all(|entry| entry.asset != Asset::Rent));
    }
}
