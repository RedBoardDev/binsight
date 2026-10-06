//! A captured mainnet case: its wallet, its transactions in order and the facts of its pools.
//!
//! A pool's bin step and mints come from its captured `LbPair` account; each mint's decimals
//! from the token balances of the case's own transactions; SOL, USDC and USDT are known mints.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use binsight_core::units::Decimals;
use binsight_dlmm::accounts::LbPair;
use binsight_dlmm::activity::TxActivity;
use binsight_dlmm::{decode_events, position_activity};
use binsight_ledger::facts::{PoolFacts, TokenFacts, TokenKind};
use binsight_solana::Address;
use binsight_solana::transaction::{TransactionView, read};
use binsight_solana::well_known::{USDC_MINT, USDT_MINT, WSOL_MINT};

/// One captured case.
pub(crate) struct Case {
    /// The public wallet whose point of view the case takes.
    pub(crate) perspective: Address,
    /// Its transactions, oldest first, with their DLMM activity.
    pub(crate) transactions: Vec<(TransactionView, TxActivity)>,
    /// The facts of its captured pools.
    pub(crate) pools: BTreeMap<Address, PoolFacts>,
}

fn folder(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/mainnet")
        .join(name)
}

/// The case `name` of `tests/fixtures/mainnet`.
#[expect(
    clippy::unwrap_used,
    reason = "a captured case and its checked domain view must be valid"
)]
pub(crate) fn case(name: &str) -> Case {
    let folder = folder(name);
    let metadata = std::fs::read_to_string(folder.join("case.toml")).unwrap();
    let perspective = metadata
        .lines()
        .find_map(|line| line.strip_prefix("perspective = \""))
        .unwrap()
        .trim_end_matches('"')
        .parse()
        .unwrap();
    let mut transactions = Vec::new();
    for index in 1.. {
        let Ok(bytes) = std::fs::read(folder.join(format!("tx-{index}.json"))) else {
            break;
        };
        let tx = read(&bytes).unwrap();
        let activity = position_activity(&tx, &decode_events(&tx).unwrap()).unwrap();
        transactions.push((tx, activity));
    }
    let pools = pools(&folder, &transactions);
    Case {
        perspective,
        transactions,
        pools,
    }
}

#[expect(
    clippy::unwrap_used,
    reason = "a captured account file holds a valid LbPair"
)]
fn pools(
    folder: &Path,
    transactions: &[(TransactionView, TxActivity)],
) -> BTreeMap<Address, PoolFacts> {
    let decimals: BTreeMap<Address, Decimals> = transactions
        .iter()
        .flat_map(|(tx, _)| tx.token_balances.iter())
        .map(|balance| (balance.mint, balance.decimals))
        .collect();
    let token = |mint: Address| TokenFacts {
        mint,
        symbol: None,
        name: None,
        decimals: decimals.get(&mint).copied().unwrap(),
        kind: match mint {
            WSOL_MINT => TokenKind::Sol,
            USDC_MINT => TokenKind::Usdc,
            USDT_MINT => TokenKind::Usdt,
            _ => TokenKind::Other,
        },
    };
    let mut pools = BTreeMap::new();
    let Ok(accounts) = std::fs::read_dir(folder.join("accounts")) else {
        return pools;
    };
    for account in accounts {
        let path = account.unwrap().path();
        let answer: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let data = answer
            .pointer("/value/data/0")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        let pair = LbPair::decode(&STANDARD.decode(data).unwrap()).unwrap();
        let address: Address = path.file_stem().unwrap().to_str().unwrap().parse().unwrap();
        let facts = PoolFacts {
            address,
            bin_step: pair.bin_step,
            base: token(pair.mint_x),
            quote: token(pair.mint_y),
        };
        pools.insert(address, facts);
    }
    pools
}
