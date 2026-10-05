//! Known protocol classifications take precedence over inferred exchanges.
#[path = "common/book.rs"]
mod common;
use binsight_dlmm::activity::TxActivity;
use binsight_ledger::book::{
    Asset, BridgeId, Counterparty, EntryKind, WalletContext, book_transaction,
};
use common::*;

fn protocol_transaction() -> binsight_solana::transaction::TransactionView {
    let mut tx = transaction(200_000, 95_000);
    tx.instructions
        .push(instruction(address(42), vec![], vec![]));
    tx.token_balances
        .push(token(address(3), address(1), address(9), 0, 50));
    tx.native_balances.push(native(address(3), 200, 200));
    tx
}

#[test]
fn a_known_bridge_books_both_assets_as_capital_instead_of_a_swap() {
    let tx = protocol_transaction();
    let mut wallet = WalletContext::new(address(1));
    wallet.bridges.insert(address(42), BridgeId::Mayan);
    let entries = book_transaction(&wallet, &tx, &TxActivity::default()).unwrap();
    assert!(entries.iter().any(|entry| entry.asset == Asset::Sol
        && entry.amount == -100_000
        && entry.kind
            == EntryKind::CapitalWithdrawal {
                counterparty: Counterparty::Bridge(BridgeId::Mayan)
            }));
    assert!(
        entries
            .iter()
            .any(|entry| entry.asset == Asset::Token { mint: address(9) }
                && entry.amount == 50
                && entry.kind
                    == EntryKind::CapitalDeposit {
                        counterparty: Counterparty::Bridge(BridgeId::Mayan)
                    })
    );
    assert!(
        entries
            .iter()
            .all(|entry| !matches!(entry.kind, EntryKind::SwapIn | EntryKind::SwapOut))
    );
}

#[test]
fn a_known_service_payment_and_an_unrelated_receipt_do_not_form_a_swap() {
    let tx = protocol_transaction();
    let mut wallet = WalletContext::new(address(1));
    wallet.services.insert(address(42));
    let entries = book_transaction(&wallet, &tx, &TxActivity::default()).unwrap();
    assert!(entries.iter().any(|entry| entry.asset == Asset::Sol
        && entry.amount == -100_000
        && entry.kind
            == EntryKind::ServiceFee {
                program: address(42)
            }));
    assert!(entries.iter().any(|entry| entry.amount == 50
        && entry.kind
            == EntryKind::ProtocolActivity {
                program: address(42)
            }));
    assert!(
        entries
            .iter()
            .all(|entry| !matches!(entry.kind, EntryKind::SwapIn | EntryKind::SwapOut))
    );
}

#[test]
fn someone_elses_token_account_rent_subsidy_creates_no_wallet_sol_or_wrap() {
    let mut tx = transaction(100_000, 95_000);
    let mut balance = token(address(3), address(1), address(9), 0, 0);
    balance.owner_pre = None;
    tx.token_balances.push(balance);
    tx.native_balances.push(native(address(3), 0, 200));
    tx.instructions.push(transfer(address(2), address(3), 200));
    let entries =
        book_transaction(&WalletContext::new(address(1)), &tx, &TxActivity::default()).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().any(|entry| entry.asset == Asset::Rent
        && entry.amount == 200
        && entry.kind
            == EntryKind::CapitalDeposit {
                counterparty: Counterparty::External {
                    address: Some(address(2))
                }
            }));
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.asset == Asset::Sol)
            .map(|entry| entry.amount)
            .sum::<i128>(),
        -5_000
    );
}

fn delegated_loss() -> binsight_solana::transaction::TransactionView {
    let mut tx = transaction(100_000, 100_000);
    tx.fee_payer = address(4);
    tx.accounts.clear();
    tx.accounts.push(binsight_solana::transaction::AccountKey {
        address: address(4),
        is_signer: true,
        is_writable: true,
        source: binsight_solana::transaction::AccountSource::Message,
    });
    tx.token_balances
        .push(token(address(2), address(1), address(9), 100, 0));
    tx.native_balances.push(native(address(2), 200, 200));
    tx
}

#[test]
fn an_unsigned_token_2022_authority_reclaim_is_a_loss_instead_of_capital() {
    let mut tx = delegated_loss();
    tx.token_balances[0].program = binsight_solana::programs::TokenProgram::Token2022;
    tx.instructions.push(instruction(
        binsight_solana::well_known::TOKEN_2022_PROGRAM,
        vec![address(2), address(3), address(4)],
        {
            let mut bytes = vec![3];
            bytes.extend(100_u64.to_le_bytes());
            bytes
        },
    ));
    let entries =
        book_transaction(&WalletContext::new(address(1)), &tx, &TxActivity::default()).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].amount, -100);
    assert_eq!(
        entries[0].kind,
        EntryKind::ProtocolActivity {
            program: binsight_solana::well_known::TOKEN_2022_PROGRAM
        }
    );
}

#[test]
fn an_unsigned_delegated_token_transfer_is_not_an_owner_capital_withdrawal() {
    let mut tx = delegated_loss();
    tx.token_balances
        .push(token(address(3), address(5), address(9), 0, 100));
    let mut bytes = vec![3];
    bytes.extend(100_u64.to_le_bytes());
    tx.instructions.push(instruction(
        binsight_solana::well_known::TOKEN_PROGRAM,
        vec![address(2), address(3), address(4)],
        bytes,
    ));
    let entries =
        book_transaction(&WalletContext::new(address(1)), &tx, &TxActivity::default()).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].amount, -100);
    assert_eq!(
        entries[0].kind,
        EntryKind::ProtocolActivity {
            program: binsight_solana::well_known::TOKEN_PROGRAM
        }
    );
}

#[test]
fn a_delegated_burn_of_owned_tokens_remains_a_burn() {
    let mut tx = delegated_loss();
    let mut bytes = vec![8];
    bytes.extend(100_u64.to_le_bytes());
    tx.instructions.push(instruction(
        binsight_solana::well_known::TOKEN_PROGRAM,
        vec![address(2), address(9), address(4)],
        bytes,
    ));
    let entries =
        book_transaction(&WalletContext::new(address(1)), &tx, &TxActivity::default()).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].amount, -100);
    assert_eq!(entries[0].kind, EntryKind::Burn);
}
