//! The default demo world: who the wallets are, what they trade and how much.
//!
//! Everything here is a named number or a short table; the generator reads it and never hides a
//! constant of its own. The world spans eighteen months: a main wallet live from the start, a
//! busy wallet that lags behind the chain and was added seven months ago, and a cold wallet added
//! two weeks ago (its earlier history is reconstructed, hence estimated).

use binsight_engine::portfolio::views::{SyncState, WalletColor};

/// The seed of the default world ("binsight" in ASCII).
pub const DEMO_SEED: u64 = 0x6269_6E73_6967_6874;

/// How far back the generated history goes.
pub(crate) const HISTORY_DAYS: i64 = 548;

/// One SOL in lamports.
pub(crate) const SOL: i128 = 1_000_000_000;

/// The rent of a position account, recovered when it closes.
pub(crate) const POSITION_RENT_LAMPORTS: u64 = 57_406_080;

/// The rent of a token account.
pub(crate) const TOKEN_ACCOUNT_RENT_LAMPORTS: u64 = 2_039_280;

/// The SOL a wallet always keeps free: top-ups keep its idle SOL above this.
pub(crate) const IDLE_MARGIN_LAMPORTS: i128 = 2 * SOL;

/// How a wallet is synchronized in the demo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SyncProfile {
    /// Its state.
    pub(crate) state: SyncState,
    /// How far behind the chain it is.
    pub(crate) lag_seconds: Option<u64>,
}

/// An open position a wallet holds now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OpenSpec {
    /// The pool key, from the catalog.
    pub(crate) pool: &'static str,
    /// Where the price stands against the range.
    pub(crate) placement: Placement,
}

/// Where the current price is placed against an open position's range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placement {
    /// Inside the range.
    Inside,
    /// Just above the range: the position holds only quote token.
    Above,
    /// Just below the range: the position holds only base token.
    Below,
}

/// A wallet of the demo world.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WalletProfile {
    /// Its label (also the seed of its streams).
    pub(crate) label: &'static str,
    /// Its color.
    pub(crate) color: WalletColor,
    /// How many days ago it first did anything.
    pub(crate) active_days: i64,
    /// How many days ago the owner added it; `None` when added at its first activity.
    pub(crate) added_days_ago: Option<i64>,
    /// How many positions it closed over its life (today and yesterday included).
    pub(crate) closed_count: usize,
    /// How many of them closed today.
    pub(crate) closed_today: usize,
    /// How many of them closed yesterday.
    pub(crate) closed_yesterday: usize,
    /// Whether its first close of today is a clear loss (so today shows losses too).
    pub(crate) loses_first_today: bool,
    /// One of its older closes in this many is an empty shell; `None` for no shell.
    pub(crate) shell_every: Option<usize>,
    /// Whether one of its position accounts was closed and created again (two lives, one
    /// address).
    pub(crate) recreates_an_address: bool,
    /// The big pools it trades, with their weights.
    pub(crate) pools: &'static [(&'static str, u64)],
    /// The share (in %) of the long-tail pools' closes it makes.
    pub(crate) long_tail_share: u64,
    /// Its open positions.
    pub(crate) open: &'static [OpenSpec],
    /// The capital it starts with, in SOL.
    pub(crate) first_deposit_sol: i128,
    /// How many times it trades outside positions, and the worst and best result in lamports.
    pub(crate) outside_trades: (usize, i128, i128),
    /// How many airdrops it received.
    pub(crate) airdrops: usize,
    /// Whether it bought the token that has no price.
    pub(crate) buys_unpriced_token: bool,
    /// How it is synchronized.
    pub(crate) sync: SyncProfile,
}

/// The wallets of the default world.
pub(crate) const WALLETS: [WalletProfile; 3] = [
    WalletProfile {
        label: "Main",
        color: WalletColor::Wallet1,
        active_days: HISTORY_DAYS,
        added_days_ago: None,
        closed_count: 1_050,
        closed_today: 5,
        closed_yesterday: 3,
        loses_first_today: true,
        shell_every: Some(90),
        recreates_an_address: true,
        pools: &[
            ("JUP/SOL", 30),
            ("JTO/SOL", 20),
            ("BONK/SOL-100", 15),
            ("POPCAT/SOL", 10),
            ("WIF/SOL", 15),
            ("SOL/USDC", 10),
        ],
        long_tail_share: 70,
        open: &[
            OpenSpec {
                pool: "JUP/SOL",
                placement: Placement::Inside,
            },
            OpenSpec {
                pool: "JTO/SOL",
                placement: Placement::Inside,
            },
            OpenSpec {
                pool: "BONK/SOL-100",
                placement: Placement::Inside,
            },
            OpenSpec {
                pool: "POPCAT/SOL",
                placement: Placement::Inside,
            },
            OpenSpec {
                pool: "JUP/SOL",
                placement: Placement::Inside,
            },
        ],
        first_deposit_sol: 40,
        outside_trades: (8, -SOL / 10, SOL / 10),
        airdrops: 3,
        buys_unpriced_token: false,
        sync: SyncProfile {
            state: SyncState::Live,
            lag_seconds: None,
        },
    },
    WalletProfile {
        label: "Degen",
        color: WalletColor::Wallet2,
        active_days: 430,
        added_days_ago: Some(213),
        closed_count: 560,
        closed_today: 2,
        closed_yesterday: 2,
        loses_first_today: true,
        shell_every: Some(200),
        recreates_an_address: false,
        pools: &[
            ("WIF/SOL", 30),
            ("POPCAT/SOL", 25),
            ("BONK/SOL-80", 25),
            ("BONK/SOL-100", 10),
            ("JTO/SOL", 10),
        ],
        long_tail_share: 30,
        open: &[
            OpenSpec {
                pool: "WIF/SOL",
                placement: Placement::Above,
            },
            OpenSpec {
                pool: "BONK/SOL-80",
                placement: Placement::Inside,
            },
        ],
        first_deposit_sol: 25,
        outside_trades: (40, -SOL / 2, SOL * 3 / 10),
        airdrops: 0,
        buys_unpriced_token: true,
        sync: SyncProfile {
            state: SyncState::Lagging,
            lag_seconds: Some(180),
        },
    },
    WalletProfile {
        label: "Cold",
        color: WalletColor::Wallet3,
        active_days: 300,
        added_days_ago: Some(13),
        closed_count: 90,
        closed_today: 1,
        closed_yesterday: 1,
        loses_first_today: false,
        shell_every: None,
        recreates_an_address: false,
        pools: &[("SOL/USDC", 50), ("JUP/USDC", 20), ("JUP/SOL", 30)],
        long_tail_share: 0,
        open: &[OpenSpec {
            pool: "JUP/USDC",
            placement: Placement::Below,
        }],
        first_deposit_sol: 120,
        outside_trades: (0, 0, 0),
        airdrops: 0,
        buys_unpriced_token: false,
        sync: SyncProfile {
            state: SyncState::Live,
            lag_seconds: None,
        },
    },
];

/// The token bought by the busy wallet that has no price (it leaves the net worth partial).
pub(crate) const UNPRICED_TOKEN_SYMBOL: &str = "GRIFT";

/// How many whole units of it the busy wallet holds.
pub(crate) const UNPRICED_TOKEN_UNITS: u128 = 1_240_000;

/// What the busy wallet paid for them, in lamports.
pub(crate) const UNPRICED_TOKEN_COST_LAMPORTS: i128 = 900_000_000;

/// The monthly credit budget of the demo instance.
pub(crate) const CREDITS_BUDGET: u64 = 1_000_000;

/// About how many credits the demo instance spends a day.
pub(crate) const CREDITS_PER_DAY: u64 = 30_000;

/// How often the open positions are valued, in seconds.
pub(crate) const VALUATION_INTERVAL_SECONDS: u64 = 10;
