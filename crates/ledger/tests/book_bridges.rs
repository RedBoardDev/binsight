//! Bridge flows are capital, never PnL or a swap.
#[path = "common/book.rs"]
mod common;

use binsight_dlmm::activity::TxActivity;
use binsight_ledger::book::{
    Asset, Counterparty, EntryKind, LedgerEntry, WalletContext, book_transaction,
};
use binsight_ledger::counterparties::BridgeId;
use binsight_solana::transaction::TransactionView;
use binsight_solana::well_known::{TOKEN_PROGRAM, USDC_MINT};
use common::*;

/// One program of each bridge, as its documentation writes it.
const ONE_PROGRAM_PER_BRIDGE: [(BridgeId, &str); 8] = [
    (
        BridgeId::Mayan,
        "mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny",
    ),
    (
        BridgeId::Relay,
        "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2",
    ),
    (
        BridgeId::DeBridge,
        "src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4",
    ),
    (
        BridgeId::Wormhole,
        "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb",
    ),
    (
        BridgeId::Allbridge,
        "CctpV8uRiXws7KZxpUXfPWy9BhCiWaeBRzsJgELvQKvu",
    ),
    (
        BridgeId::GasZip,
        "FzuVV5WeLyWHDuX6SPbeLgqkvePDTzMCRKYAhDbiP3z3",
    ),
    (
        BridgeId::Cctp,
        "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
    ),
    (
        BridgeId::Across,
        "DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru",
    ),
];

#[expect(
    clippy::unwrap_used,
    reason = "a test transaction must book successfully"
)]
fn entries_of(tx: &TransactionView) -> Vec<(Asset, i128, EntryKind)> {
    book_transaction(&WalletContext::new(address(1)), tx, &TxActivity::default())
        .unwrap()
        .into_iter()
        .map(
            |LedgerEntry {
                 asset,
                 amount,
                 kind,
                 ..
             }| (asset, amount, kind),
        )
        .collect()
}

fn assert_same_entries(actual: &[(Asset, i128, EntryKind)], expected: &[(Asset, i128, EntryKind)]) {
    assert_eq!(actual.len(), expected.len(), "{actual:?}");
    for entry in expected {
        assert!(actual.contains(entry), "missing {entry:?} in {actual:?}");
    }
}

/// 100,000 lamports leave and 50 tokens arrive through each bridge: both are capital moves
/// through that bridge, never a swap or PnL.
#[test]
fn books_the_flows_of_each_bridge_as_capital_through_it() {
    for (bridge, program) in ONE_PROGRAM_PER_BRIDGE {
        let mut tx = transaction(200_000, 95_000);
        tx.instructions
            .push(instruction(program.parse().unwrap(), vec![], vec![]));
        tx.token_balances
            .push(token(address(3), address(1), address(9), 0, 50));
        tx.native_balances.push(native(address(3), 200, 200));
        let through = Counterparty::Bridge(bridge);
        assert_same_entries(
            &entries_of(&tx),
            &[
                (Asset::Sol, -5_000, EntryKind::NetworkFee),
                (
                    Asset::Sol,
                    -100_000,
                    EntryKind::CapitalWithdrawal {
                        counterparty: through,
                    },
                ),
                (
                    Asset::Token { mint: address(9) },
                    50,
                    EntryKind::CapitalDeposit {
                        counterparty: through,
                    },
                ),
            ],
        );
    }
}

/// CCTP burns the USDC it carries to another chain: that burn is a withdrawal of capital, not
/// the disposal of a spam token.
#[test]
fn books_usdc_burnt_by_cctp_as_a_capital_withdrawal() {
    let (wallet, usdc_account) = (address(1), address(2));
    let mut tx = transaction(100_000, 95_000);
    tx.token_balances
        .push(token(usdc_account, wallet, USDC_MINT, 1_000_000, 0));
    tx.native_balances.push(native(usdc_account, 200, 200));
    tx.instructions.push(instruction(
        ONE_PROGRAM_PER_BRIDGE[6].1.parse().unwrap(),
        vec![],
        vec![],
    ));
    let mut burn = vec![8];
    burn.extend(1_000_000_u64.to_le_bytes());
    let mut burn = instruction(TOKEN_PROGRAM, vec![usdc_account, USDC_MINT, wallet], burn);
    burn.position.inner = Some(0);
    burn.stack_height = Some(2);
    tx.instructions.push(burn);
    assert_same_entries(
        &entries_of(&tx),
        &[
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (
                Asset::Token { mint: USDC_MINT },
                -1_000_000,
                EntryKind::CapitalWithdrawal {
                    counterparty: Counterparty::Bridge(BridgeId::Cctp),
                },
            ),
        ],
    );
}

/// A route swaps SOL for a token, then a Relay deposit sends that token to another chain, in one
/// transaction: what left is capital through Relay, whichever program comes first.
#[test]
fn books_a_route_into_a_bridge_as_capital_through_the_bridge() {
    let mut tx = transaction(1_000_000, 795_000);
    tx.instructions
        .push(instruction(address(22), vec![], vec![1]));
    tx.instructions.push(instruction(
        ONE_PROGRAM_PER_BRIDGE[1].1.parse().unwrap(),
        vec![],
        vec![],
    ));
    assert_same_entries(
        &entries_of(&tx),
        &[
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (
                Asset::Sol,
                -200_000,
                EntryKind::CapitalWithdrawal {
                    counterparty: Counterparty::Bridge(BridgeId::Relay),
                },
            ),
        ],
    );
}
