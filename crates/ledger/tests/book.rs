//! Conservation and classification of transaction changes from each wallet's perspective.
mod common;
use binsight_dlmm::activity::TxActivity;
use binsight_ledger::book::{
    Asset, BookError, Counterparty, EntryKind, LedgerEntry, WalletContext, book_transaction,
    invariant,
};
use binsight_solana::transaction::TxOutcome;
use binsight_solana::well_known::{JITO_TIP_ACCOUNTS, TOKEN_PROGRAM, WSOL_MINT};
use common::*;
use proptest::prelude::*;

#[expect(
    clippy::unwrap_used,
    reason = "a test transaction must book successfully"
)]
fn book(tx: &binsight_solana::transaction::TransactionView) -> Vec<LedgerEntry> {
    book_transaction(&WalletContext::new(address(1)), tx, &TxActivity::default()).unwrap()
}
fn sum(entries: &[LedgerEntry], asset: Asset) -> i128 {
    entries
        .iter()
        .filter(|entry| entry.asset == asset)
        .map(|entry| entry.amount)
        .sum()
}

#[test]
fn charges_only_the_fee_of_a_failed_transaction() {
    let mut tx = transaction(1_000_000, 990_000);
    tx.outcome = TxOutcome::Failed {
        error: "failed".into(),
    };
    tx.fee.total = binsight_core::units::Lamports(10_000);
    tx.instructions
        .push(transfer(address(1), address(2), 500_000));
    assert_eq!(
        book(&tx),
        [LedgerEntry {
            asset: Asset::Sol,
            amount: -10_000,
            kind: EntryKind::FailedTxFee
        }]
    );
}

#[test]
fn charges_nothing_when_someone_else_paid_the_failed_fee() {
    let mut tx = transaction(1_000, 1_000);
    tx.fee_payer = address(2);
    tx.outcome = TxOutcome::Failed {
        error: "failed".into(),
    };
    assert_eq!(book(&tx).len(), 0);
}

#[test]
fn refuses_a_failed_transaction_with_an_extra_change() {
    let mut tx = transaction(10_000, 4_000);
    tx.outcome = TxOutcome::Failed {
        error: "failed".into(),
    };
    assert_eq!(
        book_transaction(&WalletContext::new(address(1)), &tx, &TxActivity::default()),
        Err(BookError::FailedTxResidual { asset: Asset::Sol })
    );
}

#[test]
fn books_a_direct_sol_transfer_in_as_a_capital_deposit() {
    let mut tx = transaction(1_000_000, 1_095_000);
    tx.instructions
        .push(transfer(address(2), address(1), 100_000));
    assert_eq!(
        book(&tx)[1],
        LedgerEntry {
            asset: Asset::Sol,
            amount: 100_000,
            kind: EntryKind::CapitalDeposit {
                counterparty: Counterparty::External {
                    address: Some(address(2))
                }
            }
        }
    );
}

#[test]
fn books_a_direct_sol_transfer_out_as_a_capital_withdrawal() {
    let mut tx = transaction(1_000_000, 895_000);
    tx.instructions
        .push(transfer(address(1), address(2), 100_000));
    assert!(matches!(
        book(&tx)[1].kind,
        EntryKind::CapitalWithdrawal { .. }
    ));
}

#[test]
fn books_a_transfer_between_tracked_wallets_on_both_sides_and_cancels_in_the_aggregate() {
    let mut tx = transaction(1_000_000, 895_000);
    tx.native_balances.push(native(address(2), 0, 100_000));
    tx.instructions
        .push(transfer(address(1), address(2), 100_000));
    let mut sender = WalletContext::new(address(1));
    sender.tracked_wallets.insert(address(2));
    let mut recipient = WalletContext::new(address(2));
    recipient.tracked_wallets.insert(address(1));
    let outgoing = book_transaction(&sender, &tx, &TxActivity::default()).unwrap();
    let incoming = book_transaction(&recipient, &tx, &TxActivity::default()).unwrap();
    assert_eq!(
        outgoing[1].kind,
        EntryKind::CapitalWithdrawal {
            counterparty: Counterparty::TrackedWallet(address(2))
        }
    );
    assert_eq!(
        incoming[0].kind,
        EntryKind::CapitalDeposit {
            counterparty: Counterparty::TrackedWallet(address(1))
        }
    );
    assert_eq!(outgoing[1].amount + incoming[0].amount, 0);
}

#[test]
fn moves_nothing_between_two_token_accounts_of_the_same_wallet() {
    let mut tx = transaction(1_000_000, 995_000);
    tx.token_balances = vec![
        token(address(2), address(1), address(9), 100, 40),
        token(address(3), address(1), address(9), 20, 80),
    ];
    tx.native_balances
        .extend([native(address(2), 100, 100), native(address(3), 100, 100)]);
    assert_eq!(
        book(&tx),
        [LedgerEntry {
            asset: Asset::Sol,
            amount: -5_000,
            kind: EntryKind::NetworkFee
        }]
    );
}

#[test]
fn books_an_incoming_token_to_an_account_that_does_not_cite_the_wallet() {
    let mut tx = transaction(0, 0);
    tx.fee_payer = address(4);
    tx.token_balances.push(token(
        address(2),
        address(1),
        address(9),
        900_719_925_474_099_312_345,
        900_719_925_474_099_312_355,
    ));
    tx.native_balances.push(native(address(2), 100, 100));
    assert_eq!(sum(&book(&tx), Asset::Token { mint: address(9) }), 10);
}

#[test]
fn books_a_jito_tip_as_a_tip_even_inside_a_protocol_transaction() {
    let mut tx = transaction(100_000, 85_000);
    tx.instructions
        .push(instruction(address(22), vec![], vec![1]));
    tx.instructions
        .push(transfer(address(1), JITO_TIP_ACCOUNTS[0], 10_000));
    assert_eq!(
        book(&tx)[1],
        LedgerEntry {
            asset: Asset::Sol,
            amount: -10_000,
            kind: EntryKind::Tip
        }
    );
    assert_eq!(book(&tx).len(), 2);
}

#[test]
fn books_unknown_protocol_residue_as_protocol_activity_never_as_capital() {
    let mut tx = transaction(10_000, 20_000);
    tx.instructions
        .push(instruction(address(22), vec![], vec![1]));
    assert_eq!(
        book(&tx)[1].kind,
        EntryKind::ProtocolActivity {
            program: address(22)
        }
    );
}

#[test]
fn splits_an_ephemeral_wsol_account_into_rent_and_swap() {
    let wallet = address(1);
    let ephemeral = address(2);
    let reserve = address(3);
    let received = address(4);
    let mint = address(9);
    let mut tx = transaction(1_000_000, 895_000);
    tx.native_balances.extend([
        native(ephemeral, 0, 0),
        native(reserve, 1_000, 101_000),
        native(received, 200, 200),
    ]);
    tx.token_balances.push(token(received, wallet, mint, 0, 20));
    tx.token_balances
        .push(token(reserve, address(25), WSOL_MINT, 0, 100_000));
    tx.instructions
        .push(instruction(address(22), vec![], vec![1]));
    let mut create = 0_u32.to_le_bytes().to_vec();
    create.extend(2_000_u64.to_le_bytes());
    create.extend(165_u64.to_le_bytes());
    create.extend(TOKEN_PROGRAM.as_bytes());
    tx.instructions.push(instruction(
        binsight_solana::well_known::SYSTEM_PROGRAM,
        vec![wallet, ephemeral],
        create,
    ));
    tx.instructions.push(instruction(
        TOKEN_PROGRAM,
        vec![ephemeral, WSOL_MINT, wallet],
        vec![1],
    ));
    tx.instructions.push(transfer(wallet, ephemeral, 100_000));
    let mut transfer = vec![3];
    transfer.extend(100_000_u64.to_le_bytes());
    tx.instructions.push(instruction(
        TOKEN_PROGRAM,
        vec![ephemeral, reserve, wallet],
        transfer,
    ));
    tx.instructions.push(instruction(
        TOKEN_PROGRAM,
        vec![ephemeral, wallet, wallet],
        vec![9],
    ));
    let entries = book(&tx);
    assert!(
        entries
            .iter()
            .any(|e| e.kind == EntryKind::Wrap && e.asset == Asset::Sol && e.amount == -100_000)
    );
    assert!(entries.iter().any(|e| e.kind == EntryKind::SwapOut
        && e.asset == Asset::Token { mint: WSOL_MINT }
        && e.amount == -100_000));
    assert!(entries.iter().all(|e| !matches!(
        e.kind,
        EntryKind::ProtocolActivity { .. }
            | EntryKind::CapitalDeposit { .. }
            | EntryKind::CapitalWithdrawal { .. }
    )));
}

proptest! {
    #[test]
    fn entries_sum_to_the_real_balance_change_for_every_asset(pre in 5_000_u64..u64::MAX, post in 0_u64..u64::MAX,
        before in 0_u128..u128::from(u64::MAX),after in 0_u128..u128::from(u64::MAX)) {
        let mut tx=transaction(pre,post);
        tx.token_balances.push(token(address(2),address(1),address(9),before,after));
        tx.native_balances.push(native(address(2),100,100));
        let entries=book(&tx);
        prop_assert_eq!(sum(&entries,Asset::Sol),i128::from(post)-i128::from(pre));
        prop_assert_eq!(sum(&entries,Asset::Token{mint:address(9)}),i128::try_from(after).unwrap()-i128::try_from(before).unwrap());
        prop_assert!(invariant::check(&WalletContext::new(address(1)),&tx,&TxActivity::default(),&entries).is_ok());
        prop_assert_eq!(entries,book(&tx));
    }
    #[test]
    fn entries_do_not_depend_on_the_order_of_token_balances_in_the_meta(a in 0_u128..1_000_000,b in 0_u128..1_000_000) {
        let mut tx=transaction(1_000_000,995_000);
        tx.token_balances=vec![token(address(2),address(1),address(9),0,a),token(address(3),address(1),address(8),0,b)];
        tx.native_balances.extend([native(address(2),100,100),native(address(3),100,100)]);
        let entries=book(&tx);tx.token_balances.reverse();prop_assert_eq!(entries,book(&tx));
    }
}

#[test]
fn keeps_a_two_asset_swap_routed_through_a_dlmm_pool_as_a_swap() {
    let mut tx = transaction(10_000, 5_000);
    tx.token_balances = vec![
        token(address(2), address(1), address(9), 100, 0),
        token(address(3), address(1), address(8), 0, 20),
    ];
    tx.native_balances
        .extend([native(address(2), 200, 200), native(address(3), 200, 200)]);
    tx.instructions.push(instruction(
        binsight_dlmm::program::PROGRAM_ID,
        vec![],
        vec![1],
    ));
    let entries = book(&tx);
    assert!(
        entries
            .iter()
            .any(|entry| entry.kind == EntryKind::SwapOut && entry.amount == -100)
    );
    assert!(
        entries
            .iter()
            .any(|entry| entry.kind == EntryKind::SwapIn && entry.amount == 20)
    );
    assert_eq!(entries.len(), 3);
}

#[test]
fn keeps_each_counterparty_of_a_mixed_direct_transfer_separate() {
    let mut tx = transaction(1_000_000, 1_045_000);
    tx.instructions = vec![
        transfer(address(4), address(1), 200_000),
        transfer(address(1), address(2), 100_000),
        transfer(address(1), address(3), 50_000),
    ];
    let mut wallet = WalletContext::new(address(1));
    wallet.tracked_wallets.insert(address(2));
    let entries = book_transaction(&wallet, &tx, &TxActivity::default()).unwrap();
    assert!(entries.iter().any(
        |entry| matches!(entry.kind, EntryKind::CapitalDeposit { .. }) && entry.amount == 200_000
    ));
    assert!(entries.iter().any(|entry| entry.kind
        == EntryKind::CapitalWithdrawal {
            counterparty: Counterparty::TrackedWallet(address(2))
        }
        && entry.amount == -100_000));
    assert!(entries.iter().any(|entry| entry.kind
        == EntryKind::CapitalWithdrawal {
            counterparty: Counterparty::External {
                address: Some(address(3))
            }
        }
        && entry.amount == -50_000));
    assert_eq!(entries.len(), 4);
}
