//! Tips to landing services are on-chain costs, never a protocol loss or a swap leg.
#[path = "common/book.rs"]
mod common;

use binsight_dlmm::activity::TxActivity;
use binsight_ledger::book::{Asset, EntryKind, LedgerEntry, WalletContext, book_transaction};
use binsight_ledger::counterparties::LandingService;
use binsight_solana::Address;
use binsight_solana::transaction::TransactionView;
use binsight_solana::well_known::WSOL_MINT;
use common::*;

/// One tip account of each landing service, as its documentation writes it.
const ONE_TIP_ACCOUNT_PER_SERVICE: [(LandingService, &str); 11] = [
    (
        LandingService::Jito,
        "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    ),
    (
        LandingService::HeliusSender,
        "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
    ),
    (
        LandingService::Nozomi,
        "TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq",
    ),
    (
        LandingService::BloXroute,
        "3UQUKjhMKaY2S6bjcQD6yHB7utcZt5bfarRCmctpRtUd",
    ),
    (
        LandingService::ZeroSlot,
        "6fQaVhYZA4w3MBSXjJ81Vf6W1EDYeUPXpgVQ6UQyU1Av",
    ),
    (
        LandingService::NextBlock,
        "NextbLoCkVtMGcV47JzewQdvBpLqT9TxQFozQkN98pE",
    ),
    (
        LandingService::Astralane,
        "astrazznxsGUhWShqgNtAdfrzP2G83DzcWVJDxwV9bF",
    ),
    (
        LandingService::BlockRazor,
        "FjmZZrFvhnqqb9ThCuMVnENaM3JGVuGWNyCAxRJcFpg9",
    ),
    (
        LandingService::Falcon,
        "Fa1con11xLjPddfzRwRUB16sbFZggp2JeJkCeWREyR8X",
    ),
    (
        LandingService::JupiterBeam,
        "GGztQqQ6pCPaJQnNpXBgELr5cs3WwDakRbh1iEMzjgSJ",
    ),
    (
        LandingService::Lightspeed,
        "svsMoWJBwLcs8JgfN8VaF111tAc199KpYeTKRwxRtip",
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

#[test]
fn books_a_tip_to_each_landing_service_as_a_tip() {
    for (service, account) in ONE_TIP_ACCOUNT_PER_SERVICE {
        let mut tx = transaction(1_000_000, 985_000);
        tx.instructions
            .push(instruction(address(22), vec![], vec![1]));
        tx.instructions
            .push(transfer(address(1), account.parse().unwrap(), 10_000));
        assert_same_entries(
            &entries_of(&tx),
            &[
                (Asset::Sol, -5_000, EntryKind::NetworkFee),
                (Asset::Sol, -10_000, EntryKind::Tip { service }),
            ],
        );
    }
}

/// The wallet swaps 100,000 lamports of wrapped SOL for 20 tokens and tips Helius Sender
/// 1,000,000 lamports in the same transaction: the tip is a cost, not a third swap leg.
#[test]
fn keeps_a_tip_inside_a_swap_out_of_the_swap_legs() {
    let (wallet, wsol_account, token_account, mint) =
        (address(1), address(2), address(3), address(9));
    let mut tx = transaction(2_000_000, 995_000);
    tx.token_balances = vec![
        token(wsol_account, wallet, WSOL_MINT, 100_000, 0),
        token(token_account, wallet, mint, 0, 20),
    ];
    tx.native_balances.extend([
        native(wsol_account, 2_139_280, 2_039_280),
        native(token_account, 2_039_280, 2_039_280),
    ]);
    tx.instructions
        .push(instruction(address(22), vec![], vec![1]));
    let sender: Address = ONE_TIP_ACCOUNT_PER_SERVICE[1].1.parse().unwrap();
    tx.instructions.push(transfer(wallet, sender, 1_000_000));
    assert_same_entries(
        &entries_of(&tx),
        &[
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (
                Asset::Sol,
                -1_000_000,
                EntryKind::Tip {
                    service: LandingService::HeliusSender,
                },
            ),
            (
                Asset::Token { mint: WSOL_MINT },
                -100_000,
                EntryKind::SwapOut,
            ),
            (Asset::Token { mint }, 20, EntryKind::SwapIn),
        ],
    );
}
