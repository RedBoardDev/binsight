//! Direct Token-2022 capital keeps every counterparty and the recipient's actual transfer tax.
#[path = "common/book.rs"]
mod common;
use binsight_dlmm::activity::TxActivity;
use binsight_ledger::book::{Counterparty, EntryKind, WalletContext, book_transaction};
use common::*;

#[test]
fn mixed_direct_token_2022_transfers_keep_tracked_and_external_capital_separate() {
    let mut tx = transaction(100_000, 95_000);
    tx.accounts.push(binsight_solana::transaction::AccountKey {
        address: address(4),
        is_signer: true,
        is_writable: true,
        source: binsight_solana::transaction::AccountSource::Message,
    });
    tx.token_balances = vec![
        token(address(2), address(1), address(9), 0, 50),
        token(address(3), address(4), address(9), 100, 0),
        token(address(5), address(6), address(9), 0, 50),
    ];
    for balance in &mut tx.token_balances {
        balance.program = binsight_solana::programs::TokenProgram::Token2022;
    }
    tx.native_balances.extend([
        native(address(2), 200, 200),
        native(address(3), 200, 200),
        native(address(5), 200, 200),
    ]);
    for (from, to, authority, amount) in [
        (address(3), address(2), address(4), 100_u64),
        (address(2), address(5), address(1), 50),
    ] {
        let mut bytes = vec![3];
        bytes.extend(amount.to_le_bytes());
        tx.instructions.push(instruction(
            binsight_solana::well_known::TOKEN_2022_PROGRAM,
            vec![from, to, authority],
            bytes,
        ));
    }
    let mut a = WalletContext::new(address(1));
    a.tracked_wallets.insert(address(4));
    let mut b = WalletContext::new(address(4));
    b.tracked_wallets.insert(address(1));
    let a_entries = book_transaction(&a, &tx, &TxActivity::default()).unwrap();
    let b_entries = book_transaction(&b, &tx, &TxActivity::default()).unwrap();
    assert!(a_entries.iter().any(|entry| entry.amount == 100
        && entry.kind
            == EntryKind::CapitalDeposit {
                counterparty: Counterparty::TrackedWallet(address(4))
            }));
    assert!(a_entries.iter().any(|entry| entry.amount == -50
        && entry.kind
            == EntryKind::CapitalWithdrawal {
                counterparty: Counterparty::External {
                    address: Some(address(6))
                }
            }));
    assert!(b_entries.iter().any(|entry| entry.amount == -100
        && entry.kind
            == EntryKind::CapitalWithdrawal {
                counterparty: Counterparty::TrackedWallet(address(1))
            }));
}

#[test]
fn direct_token_2022_gross_tracked_capital_cancels_and_receipt_tax_stays_a_cost() {
    let mut tx = transaction(100_000, 100_000);
    tx.fee_payer = address(4);
    tx.token_balances = vec![
        token(address(2), address(1), address(9), 0, 95),
        token(address(3), address(4), address(9), 100, 0),
    ];
    for balance in &mut tx.token_balances {
        balance.program = binsight_solana::programs::TokenProgram::Token2022;
    }
    tx.native_balances
        .extend([native(address(2), 200, 200), native(address(3), 200, 200)]);
    tx.accounts.push(binsight_solana::transaction::AccountKey {
        address: address(4),
        is_signer: true,
        is_writable: true,
        source: binsight_solana::transaction::AccountSource::Message,
    });
    let mut bytes = vec![26, 1];
    bytes.extend(100_u64.to_le_bytes());
    bytes.push(6);
    bytes.extend(5_u64.to_le_bytes());
    tx.instructions.push(instruction(
        binsight_solana::well_known::TOKEN_2022_PROGRAM,
        vec![address(3), address(9), address(2), address(4)],
        bytes,
    ));
    let mut a = WalletContext::new(address(1));
    a.tracked_wallets.insert(address(4));
    let mut b = WalletContext::new(address(4));
    b.tracked_wallets.insert(address(1));
    let a_entries = book_transaction(&a, &tx, &TxActivity::default()).unwrap();
    let b_entries = book_transaction(&b, &tx, &TxActivity::default()).unwrap();
    assert!(a_entries.iter().any(|entry| entry.amount == 100
        && entry.kind
            == EntryKind::CapitalDeposit {
                counterparty: Counterparty::TrackedWallet(address(4))
            }));
    assert!(
        a_entries
            .iter()
            .any(|entry| entry.amount == -5 && entry.kind == EntryKind::TransferFee)
    );
    let tracked_capital: i128 = a_entries
        .iter()
        .chain(&b_entries)
        .filter(|entry| {
            matches!(
                entry.kind,
                EntryKind::CapitalDeposit {
                    counterparty: Counterparty::TrackedWallet(_)
                } | EntryKind::CapitalWithdrawal {
                    counterparty: Counterparty::TrackedWallet(_)
                }
            )
        })
        .map(|entry| entry.amount)
        .sum();
    assert_eq!(tracked_capital, 0);
    a.tracked_wallets.clear();
    let external = book_transaction(&a, &tx, &TxActivity::default()).unwrap();
    assert!(external.iter().any(|entry| entry.amount == 100
        && entry.kind
            == EntryKind::CapitalDeposit {
                counterparty: Counterparty::External {
                    address: Some(address(4))
                }
            }));
    assert!(
        external
            .iter()
            .any(|entry| entry.amount == -5 && entry.kind == EntryKind::TransferFee)
    );
}
