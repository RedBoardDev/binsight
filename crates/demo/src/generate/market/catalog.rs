//! The tokens and pools of the demo world, with the price each pool starts around.
//!
//! Eight busy pools carry most of the activity; a long tail of thirty small pools on invented
//! tokens shows how the history filters behave with many pools, two of them on the same pair with
//! different bin steps. One token has no metadata at all. Every mint and pool address is fake.

use std::collections::BTreeMap;

use binsight_core::units::Decimals;
use binsight_ledger::facts::{PoolFacts, TokenFacts, TokenKind};

use super::bins::{bin_at_or_below, raw_price};
use crate::addresses::address;
use crate::error::DemoError;
use crate::random::Stream;

/// A token of the catalog: ticker, name, decimals and kind.
struct TokenSpec {
    symbol: Option<&'static str>,
    name: Option<&'static str>,
    decimals: u8,
    kind: TokenKind,
}

/// The tokens of the busy pools.
const BUSY_TOKENS: [TokenSpec; 7] = [
    TokenSpec {
        symbol: Some("SOL"),
        name: Some("Solana"),
        decimals: 9,
        kind: TokenKind::Sol,
    },
    TokenSpec {
        symbol: Some("USDC"),
        name: Some("USD Coin"),
        decimals: 6,
        kind: TokenKind::Usdc,
    },
    TokenSpec {
        symbol: Some("JUP"),
        name: Some("Jupiter"),
        decimals: 6,
        kind: TokenKind::Other,
    },
    TokenSpec {
        symbol: Some("JTO"),
        name: Some("Jito"),
        decimals: 9,
        kind: TokenKind::Other,
    },
    TokenSpec {
        symbol: Some("WIF"),
        name: Some("dogwifhat"),
        decimals: 6,
        kind: TokenKind::Other,
    },
    TokenSpec {
        symbol: Some("POPCAT"),
        name: Some("Popcat"),
        decimals: 9,
        kind: TokenKind::Other,
    },
    TokenSpec {
        symbol: Some("BONK"),
        name: Some("Bonk"),
        decimals: 5,
        kind: TokenKind::Other,
    },
];

/// A busy pool: its key, base and quote symbols, bin step, and the price of one base token in
/// quote tokens it starts around (`numerator / denominator`).
type BusyPool = (&'static str, &'static str, &'static str, u16, (u128, u128));

/// The busy pools.
const BUSY_POOLS: [BusyPool; 8] = [
    ("SOL/USDC", "SOL", "USDC", 10, (145, 1)),
    ("JUP/USDC", "JUP", "USDC", 20, (58, 100)),
    ("JUP/SOL", "JUP", "SOL", 20, (4, 1_000)),
    ("JTO/SOL", "JTO", "SOL", 50, (15, 1_000)),
    ("WIF/SOL", "WIF", "SOL", 80, (8, 1_000)),
    ("POPCAT/SOL", "POPCAT", "SOL", 80, (25, 10_000)),
    ("BONK/SOL-80", "BONK", "SOL", 80, (12, 100_000_000)),
    ("BONK/SOL-100", "BONK", "SOL", 100, (12, 100_000_000)),
];

/// The invented tokens of the long tail; the last one has no metadata.
const TAIL_SYMBOLS: [Option<&str>; 18] = [
    Some("MOTH"),
    Some("KELP"),
    Some("ZINC"),
    Some("ORBIT"),
    Some("PIXEL"),
    Some("DUNE"),
    Some("FERN"),
    Some("GLOW"),
    Some("HALO"),
    Some("IRIS"),
    Some("JOLT"),
    Some("KOI"),
    Some("LUMA"),
    Some("NOVA"),
    Some("OPAL"),
    Some("PLUM"),
    Some("QUILL"),
    None,
];

/// The bin steps the long-tail pools use.
const TAIL_BIN_STEPS: [u16; 6] = [20, 25, 50, 80, 100, 250];

/// How many long-tail pools there are.
pub(crate) const TAIL_POOL_COUNT: usize = 30;

/// A pool of the catalog and the bin its price starts around.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CatalogPool {
    /// The key the scenario names it by (`JUP/SOL`, `tail-3`).
    pub(crate) key: String,
    /// Its facts.
    pub(crate) facts: PoolFacts,
    /// The bin of its reference price.
    pub(crate) reference_bin: i32,
    /// Whether it belongs to the long tail.
    pub(crate) is_long_tail: bool,
}

/// Every token and pool of the world.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Catalog {
    /// The pools, busy ones first.
    pub(crate) pools: Vec<CatalogPool>,
    /// The unpriced token the busy wallet holds.
    pub(crate) unpriced_token: TokenFacts,
}

impl Catalog {
    /// The pool named `key`.
    pub(crate) fn pool(&self, key: &str) -> Result<&CatalogPool, DemoError> {
        self.pools
            .iter()
            .find(|pool| pool.key == key)
            .ok_or(DemoError::UnknownPool)
    }

    /// The long-tail pools.
    pub(crate) fn long_tail(&self) -> impl Iterator<Item = &CatalogPool> {
        self.pools.iter().filter(|pool| pool.is_long_tail)
    }
}

/// Builds the catalog of the world of `seed`.
pub(crate) fn catalog(seed: u64) -> Result<Catalog, DemoError> {
    let tokens: BTreeMap<&str, TokenFacts> = BUSY_TOKENS
        .iter()
        .filter_map(|spec| spec.symbol.map(|symbol| (symbol, token(spec))))
        .collect();
    let find = |symbol: &str| tokens.get(symbol).cloned().ok_or(DemoError::UnknownPool);
    let mut pools = Vec::new();
    for (key, base, quote, bin_step, price) in BUSY_POOLS {
        pools.push(pool(
            key.to_owned(),
            find(base)?,
            find(quote)?,
            bin_step,
            price,
            false,
        )?);
    }
    let sol = find("SOL")?;
    let mut stream = Stream::of(seed, "catalog:long-tail");
    let tail_tokens: Vec<(TokenFacts, (u128, u128))> = TAIL_SYMBOLS
        .iter()
        .enumerate()
        .map(|(index, symbol)| {
            let facts = TokenFacts {
                mint: address(&format!("token:tail-{index}")),
                symbol: symbol.map(str::to_owned),
                name: None,
                decimals: Decimals([5, 6, 9].get(index % 3).copied().unwrap_or(6)),
                kind: TokenKind::Other,
            };
            let sol_price = (
                u128::from(stream.below(500_000)).saturating_add(1),
                10_000_000,
            );
            (facts, sol_price)
        })
        .collect();
    for index in 0..TAIL_POOL_COUNT {
        let Some((base, price)) = tail_tokens
            .get(index.checked_rem(tail_tokens.len()).unwrap_or(0))
            .cloned()
        else {
            continue;
        };
        // A token's second pool uses another bin step, as the same pair at two steps.
        let round = index.checked_div(tail_tokens.len()).unwrap_or(0);
        let step_index = index
            .saturating_add(round)
            .checked_rem(TAIL_BIN_STEPS.len())
            .unwrap_or(0);
        let bin_step = TAIL_BIN_STEPS.get(step_index).copied().unwrap_or(25);
        pools.push(pool(
            format!("tail-{index}"),
            base,
            sol.clone(),
            bin_step,
            price,
            true,
        )?);
    }
    Ok(Catalog {
        pools,
        unpriced_token: TokenFacts {
            mint: address("token:unpriced"),
            symbol: Some(crate::scenario::UNPRICED_TOKEN_SYMBOL.to_owned()),
            name: None,
            decimals: Decimals(6),
            kind: TokenKind::Other,
        },
    })
}

/// The facts of a busy token.
fn token(spec: &TokenSpec) -> TokenFacts {
    TokenFacts {
        mint: address(&format!("token:{}", spec.symbol.unwrap_or("unnamed"))),
        symbol: spec.symbol.map(str::to_owned),
        name: spec.name.map(str::to_owned),
        decimals: Decimals(spec.decimals),
        kind: spec.kind,
    }
}

/// A pool and the bin of its reference price (of one base token, in quote tokens).
fn pool(
    key: String,
    base: TokenFacts,
    quote: TokenFacts,
    bin_step: u16,
    (numerator, denominator): (u128, u128),
    is_long_tail: bool,
) -> Result<CatalogPool, DemoError> {
    let reference = raw_price(numerator, denominator, base.decimals.0, quote.decimals.0)
        .ok_or(DemoError::OutOfRange)?;
    Ok(CatalogPool {
        reference_bin: bin_at_or_below(reference, bin_step)?,
        facts: PoolFacts {
            address: address(&format!("pool:{key}")),
            bin_step,
            base,
            quote,
        },
        key,
        is_long_tail,
    })
}
