//! A small random wallet whose facts satisfy the accounting identity, for the read-rule tests.
//!
//! Positions, entries and marks are drawn from a seed; the idle SOL is then whatever makes
//! net worth − capital equal everything realized plus the open PnL, as real accounting would
//! observe it.

#![allow(
    clippy::unwrap_used,
    clippy::arithmetic_side_effects,
    reason = "test fixtures compute with small bounded integers"
)]

mod marks;

use binsight_ledger::facts::PositionHistory;
use binsight_ledger::facts::UnpricedMovements;
use std::collections::BTreeMap;

use binsight_core::money::{SignedLamports, SolUsdRate};
use binsight_core::units::{Decimals, Lamports};
use binsight_ledger::facts::{
    ClosedPositionFacts, HistoryCoverage, OpenPnlMark, OpenPositionFacts, PnlMethod, PoolFacts,
    PositionId, QuoteUnits, SolUsdRates, Strategy, TokenFacts, TokenKind, WalletEntry,
    WalletEntryKind, WalletFacts, WalletHoldings,
};
use binsight_ledger::report::figure::Figure;
use binsight_solana::{Address, Signature};
use jiff::Timestamp;
use jiff::tz::TimeZone;
use marks::hourly_marks;

/// The instant the test wallet is valued at.
pub(crate) const NOW_SECONDS: i64 = 1_790_000_000;

/// How far back the wallet's history goes.
const HISTORY_DAYS: i64 = 60;

/// A deterministic pseudo-random sequence (`SplitMix64`).
pub(crate) struct Draws(u64);

impl Draws {
    pub(crate) fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub(crate) fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A number in `low..high`.
    pub(crate) fn between(&mut self, low: i64, high: i64) -> i64 {
        let width = u64::try_from(high - low).unwrap();
        low + i64::try_from(self.next() % width).unwrap()
    }

    /// A wide number in `low..high`, for amounts.
    pub(crate) fn amount(&mut self, low: i64, high: i64) -> i128 {
        i128::from(self.between(low, high))
    }
}

/// The facts of one wallet.
pub(crate) struct WalletWorld {
    pub(crate) wallet: WalletFacts,
    pub(crate) pool: PoolFacts,
    pub(crate) closed: Vec<ClosedPositionFacts>,
    pub(crate) open: Vec<OpenPositionFacts>,
    pub(crate) entries: Vec<WalletEntry>,
    pub(crate) marks: Vec<OpenPnlMark>,
    pub(crate) holdings: WalletHoldings,
    pub(crate) rates: SolUsdRates,
    pub(crate) now: Timestamp,
}

pub(crate) fn at(seconds: i64) -> Timestamp {
    Timestamp::from_second(seconds).unwrap()
}

fn sol_token() -> TokenFacts {
    TokenFacts {
        mint: Address::from_bytes([3; 32]),
        symbol: Some("SOL".to_owned()),
        name: None,
        decimals: Decimals::SOL,
        kind: TokenKind::Sol,
    }
}

/// A random wallet drawn from `seed`.
pub(crate) fn wallet_world(seed: u64) -> WalletWorld {
    let mut draws = Draws::new(seed);
    let now = at(NOW_SECONDS);
    let start = NOW_SECONDS - HISTORY_DAYS * 86_400;
    let pool = pool();
    let closed = closed_positions(&mut draws, &pool, start);
    let (open, open_pnl_now) = open_positions(&mut draws, &pool, now);
    let entries = wallet_entries(&mut draws, start);
    let open_opened = open
        .iter()
        .map(|position| position.opened_at.as_second())
        .min();
    let marks = hourly_marks(start, &closed, open_opened, open_pnl_now);
    let holdings = balancing_holdings(&closed, &open, &entries, open_pnl_now, now);
    WalletWorld {
        wallet: WalletFacts {
            address: WALLET,
            added_at: at(start + draws.between(0, HISTORY_DAYS * 86_400)),
            history: HistoryCoverage::Complete,
        },
        pool,
        closed,
        open,
        entries,
        marks,
        holdings,
        rates: daily_rates(&mut draws, start),
        now,
    }
}

/// The address of the test wallet.
const WALLET: Address = Address::from_bytes([1; 32]);

fn pool() -> PoolFacts {
    PoolFacts {
        address: Address::from_bytes([2; 32]),
        bin_step: 10,
        base: TokenFacts {
            mint: Address::from_bytes([4; 32]),
            symbol: Some("JUP".to_owned()),
            name: None,
            decimals: Decimals(6),
            kind: TokenKind::Other,
        },
        quote: sol_token(),
    }
}

fn position_id(n: u8) -> PositionId {
    PositionId {
        address: Address::from_bytes([n; 32]),
        opened_by: Signature::from_bytes([n; 64]),
    }
}

fn closed_positions(draws: &mut Draws, pool: &PoolFacts, start: i64) -> Vec<ClosedPositionFacts> {
    let count = u8::try_from(draws.between(5, 30)).unwrap();
    (0..count)
        .map(|n| {
            let opened = draws.between(start, NOW_SECONDS - 7_200);
            let closed_at = draws.between(opened + 60, NOW_SECONDS - 1);
            let invested = draws.amount(1_000_000, 5_000_000_000);
            let pnl = draws.amount(-50_000_000, 50_000_000);
            let fees = draws.amount(0, 10_000_000);
            let method = if draws.next().is_multiple_of(2) {
                PnlMethod::Pool
            } else {
                PnlMethod::Fifo {
                    market_pnl: QuoteUnits(pnl + fees - draws.amount(0, 1_000_000)),
                }
            };
            ClosedPositionFacts {
                id: position_id(n + 10),
                wallet: WALLET,
                pool: pool.address,
                strategy: Some(Strategy::Spot),
                opened_at: at(opened),
                closed_at: at(closed_at),
                invested: QuoteUnits(invested),
                withdrawn: QuoteUnits(invested + pnl),
                claimed_fees: QuoteUnits(fees),
                rewards: QuoteUnits(0),
                unpriced_rewards: 0,
                method,
                history: PositionHistory::Whole,
                dust_movements: 0,
                unpriced_movements: UnpricedMovements::default(),
            }
        })
        .collect()
}

/// One open position and its open PnL now.
fn open_positions(
    draws: &mut Draws,
    pool: &PoolFacts,
    now: Timestamp,
) -> (Vec<OpenPositionFacts>, i128) {
    let invested = draws.amount(1_000_000_000, 3_000_000_000);
    let drift = draws.amount(-80_000_000, 80_000_000);
    let unclaimed = 1_000_000;
    let position = OpenPositionFacts {
        id: position_id(200),
        wallet: WALLET,
        pool: pool.address,
        strategy: Some(Strategy::Curve),
        opened_at: at(NOW_SECONDS - draws.between(3_600, 86_400 * 3)),
        invested: QuoteUnits(invested),
        withdrawn: QuoteUnits(0),
        claimed_fees: QuoteUnits(0),
        rewards: QuoteUnits(0),
        unpriced_rewards: 0,
        value: Figure::Complete(QuoteUnits(invested + drift)),
        unclaimed_fees: Figure::Complete(QuoteUnits(unclaimed)),
        unclaimed_fee_presence: Some(true),
        lower_bin_id: -10,
        upper_bin_id: 10,
        active_bin_id: 0,
        bins: Vec::new(),
        range_since: None,
        valued_at: now,
        history: PositionHistory::Whole,
        dust_movements: 0,
        unpriced_movements: UnpricedMovements::default(),
    };
    (vec![position], drift + unclaimed)
}

fn wallet_entries(draws: &mut Draws, start: i64) -> Vec<WalletEntry> {
    let entry = |at: i64, kind, amount: i128| WalletEntry {
        wallet: WALLET,
        at: Timestamp::from_second(at).unwrap(),
        kind,
        amount: SignedLamports(amount),
        signature: None,
    };
    let mut entries = vec![entry(
        start,
        WalletEntryKind::CapitalDeposit,
        50_000_000_000,
    )];
    for _ in 0..draws.between(5, 40) {
        let when = draws.between(start, NOW_SECONDS - 1);
        let (kind, amount) = match draws.next() % 5 {
            0 => (WalletEntryKind::NetworkFee, -5_000),
            1 => (WalletEntryKind::PriorityFee, -draws.amount(10_000, 200_000)),
            2 => (
                WalletEntryKind::PureTrading,
                draws.amount(-90_000_000, 40_000_000),
            ),
            3 => (
                WalletEntryKind::CapitalWithdrawal,
                -draws.amount(1, 900_000_000),
            ),
            _ => (
                WalletEntryKind::CapitalDeposit,
                draws.amount(1, 900_000_000),
            ),
        };
        entries.push(entry(when, kind, amount));
    }
    entries
}

/// The holdings that make net worth − capital equal everything realized plus the open PnL.
fn balancing_holdings(
    closed: &[ClosedPositionFacts],
    open: &[OpenPositionFacts],
    entries: &[WalletEntry],
    open_pnl_now: i128,
    now: Timestamp,
) -> WalletHoldings {
    let sum_entries = |is_capital: bool| -> i128 {
        entries
            .iter()
            .filter(|entry| entry.kind.is_capital() == is_capital)
            .map(|entry| entry.amount.0)
            .sum()
    };
    let realized = closed.iter().map(position_pnl).sum::<i128>() + sum_entries(false);
    let in_positions: i128 = open
        .iter()
        .map(|position| {
            let known = |figure: &Figure<QuoteUnits>| {
                assert_eq!(
                    figure.exactness(),
                    binsight_core::exactness::Exactness::Complete
                );
                figure.value().unwrap().0
            };
            known(&position.value) + known(&position.unclaimed_fees)
        })
        .sum();
    let idle = sum_entries(true) + realized + open_pnl_now - in_positions;
    WalletHoldings {
        wallet: WALLET,
        idle: Lamports(u64::try_from(idle).unwrap()),
        recoverable_rent: Lamports(0),
        unpriced: Vec::new(),
        observed_at: now,
    }
}

fn daily_rates(draws: &mut Draws, start: i64) -> SolUsdRates {
    let mut daily = BTreeMap::new();
    for day in 0..=HISTORY_DAYS + 1 {
        let date = at(start + day * 86_400).to_zoned(TimeZone::UTC).date();
        let micro_usd = u64::try_from(draws.between(80_000_000, 300_000_000)).unwrap();
        daily.insert(date, SolUsdRate::new(micro_usd).unwrap());
    }
    SolUsdRates {
        daily,
        spot: SolUsdRate::new(150_000_000),
        provisional: None,
    }
}

/// The native PnL of a closed position.
pub(crate) fn position_pnl(position: &ClosedPositionFacts) -> i128 {
    match position.method {
        PnlMethod::Fifo { market_pnl } => market_pnl.0,
        PnlMethod::Pool => position.withdrawn.0 + position.claimed_fees.0 - position.invested.0,
    }
}
