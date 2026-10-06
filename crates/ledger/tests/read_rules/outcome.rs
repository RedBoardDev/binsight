//! Native signs are read independently of display conversion; an unpriced leg that hides the
//! sign gives an unknown outcome, counted apart and left out of the win rate.
#![allow(
    clippy::unwrap_used,
    clippy::arithmetic_side_effects,
    reason = "tests fail loudly and sum bounded counts"
)]

use super::common;

use binsight_core::exactness::Exactness;
use binsight_core::ratio::Percent;
use binsight_core::units::Decimals;
use binsight_ledger::facts::{PnlMethod, QuoteUnits, TokenKind};
use binsight_ledger::report::closed::{ClosedValuation, Outcome};
use binsight_ledger::report::closed_totals::ClosedTotals;
use binsight_ledger::report::figure::Figure;

#[test]
fn gives_an_unknown_outcome_to_a_negative_subtotal_with_an_unpriced_reward() {
    let mut world = common::wallet_world(9);
    let position = world.closed.first_mut().unwrap();
    position.invested = QuoteUnits(1);
    position.withdrawn = QuoteUnits(0);
    position.claimed_fees = QuoteUnits(0);
    position.rewards = QuoteUnits(0);
    position.method = PnlMethod::Pool;
    position.unpriced_rewards = 1;
    assert_eq!(
        ClosedValuation::of(position, &world.pool, &world.rates)
            .unwrap()
            .outcome,
        Outcome::Unknown
    );

    position.unpriced_rewards = 0;
    for (reward, expected) in [(0, Outcome::Loss), (1, Outcome::Flat), (2, Outcome::Win)] {
        position.rewards = QuoteUnits(reward);
        assert_eq!(
            ClosedValuation::of(position, &world.pool, &world.rates)
                .unwrap()
                .outcome,
            expected
        );
    }
}

#[test]
fn proves_positive_income_and_empty_shells_but_never_unknown_costs() {
    let mut world = common::wallet_world(9);
    let position = world.closed.first_mut().unwrap();
    position.invested = QuoteUnits(0);
    position.withdrawn = QuoteUnits(1);
    position.claimed_fees = QuoteUnits(0);
    position.rewards = QuoteUnits(0);
    position.method = PnlMethod::Pool;
    position.unpriced_rewards = 1;
    let proved_win = ClosedValuation::of(position, &world.pool, &world.rates).unwrap();
    assert_eq!(proved_win.outcome, Outcome::Win);
    assert_eq!(
        ClosedTotals::of([&proved_win])
            .unwrap()
            .win_rate
            .exactness(),
        Exactness::Complete
    );
    position.unpriced_movements = 1;
    assert_eq!(
        ClosedValuation::of(position, &world.pool, &world.rates)
            .unwrap()
            .outcome,
        Outcome::Unknown
    );
    position.unpriced_movements = 0;
    position.unpriced_rewards = 0;
    position.withdrawn = QuoteUnits(0);
    let shell = ClosedValuation::of(position, &world.pool, &world.rates).unwrap();
    assert_eq!(shell.outcome, Outcome::Flat);
    assert!(shell.is_shell);
}

#[test]
fn preserves_a_native_dollar_win_without_a_sol_conversion_rate() {
    let mut world = common::wallet_world(9);
    let position = world.closed.first_mut().unwrap();
    position.invested = QuoteUnits(0);
    position.withdrawn = QuoteUnits(1);
    position.claimed_fees = QuoteUnits(0);
    position.rewards = QuoteUnits(0);
    position.method = PnlMethod::Pool;
    world.pool.quote.kind = TokenKind::Usdc;
    world.pool.quote.decimals = Decimals(6);
    world.rates.daily.clear();
    world.rates.spot = None;
    assert_eq!(
        ClosedValuation::of(position, &world.pool, &world.rates)
            .unwrap()
            .outcome,
        Outcome::Win
    );
}

#[test]
fn counts_unknown_outcomes_and_leaves_them_out_of_the_win_rate() {
    let world = common::wallet_world(9);
    let mut facts = world.closed.first().unwrap().clone();
    facts.invested = QuoteUnits(1);
    facts.claimed_fees = QuoteUnits(0);
    facts.rewards = QuoteUnits(0);
    facts.method = PnlMethod::Pool;
    let mut positions = Vec::new();
    for withdrawn in [2, 0, 1] {
        facts.withdrawn = QuoteUnits(withdrawn);
        positions.push(ClosedValuation::of(&facts, &world.pool, &world.rates).unwrap());
    }
    facts.unpriced_rewards = 1;
    let unknown = ClosedValuation::of(&facts, &world.pool, &world.rates).unwrap();
    assert_eq!(unknown.outcome, Outcome::Unknown);
    positions.push(unknown.clone());
    let totals = ClosedTotals::of(&positions).unwrap();
    assert_eq!(
        (
            totals.count,
            totals.wins,
            totals.losses,
            totals.flat,
            totals.unknown
        ),
        (4, 1, 1, 1, 1)
    );
    assert_eq!(
        totals.count,
        totals.wins + totals.losses + totals.flat + totals.unknown
    );
    assert_eq!(totals.win_rate, Figure::Complete(Percent(50_000_000)));
    let only_unknown = ClosedTotals::of([&unknown]).unwrap();
    assert_eq!(only_unknown.win_rate.exactness(), Exactness::Unavailable);
    assert!(only_unknown.win_rate.value().is_none());
}
