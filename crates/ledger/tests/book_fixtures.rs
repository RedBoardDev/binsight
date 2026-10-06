//! Public mainnet conservation, with classification checked where lifecycle proves ownership.
//! Standalone snapshots without ownership history prove conservation only.
use binsight_dlmm::activity::TxActivity;
use binsight_dlmm::{decode_events, position_activity};
use binsight_ledger::book::{Asset, EntryKind, WalletContext, book_transaction, invariant};
use binsight_ledger::counterparties::LandingService;
use binsight_solana::transaction::{TransactionView, read};

#[expect(
    clippy::unwrap_used,
    reason = "fixture files and their checked domain view must be valid"
)]
fn fixture(
    folder: &std::path::Path,
    path: &std::path::Path,
) -> (WalletContext, TransactionView, TxActivity) {
    let metadata = std::fs::read_to_string(folder.join("case.toml")).unwrap();
    let perspective = metadata
        .lines()
        .find_map(|line| line.strip_prefix("perspective = \""))
        .unwrap()
        .trim_end_matches('"')
        .parse()
        .unwrap();
    let tx = read(&std::fs::read(path).unwrap()).unwrap();
    let activity = position_activity(&tx, &decode_events(&tx).unwrap()).unwrap();
    (WalletContext::new(perspective), tx, activity)
}

fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mainnet")
}

#[test]
fn books_every_public_transaction_fixture_and_conserves_its_assets() {
    let mut cases = 0;
    for folder in std::fs::read_dir(root()).unwrap() {
        let folder = folder.unwrap().path();
        for path in std::fs::read_dir(&folder).unwrap() {
            let path = path.unwrap().path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let (wallet, tx, activity) = fixture(&folder, &path);
            let entries = book_transaction(&wallet, &tx, &activity)
                .unwrap_or_else(|error| panic!("{}: {error:?}", path.display()));
            invariant::check(&wallet, &tx, &activity, &entries).unwrap();
            cases += 1;
        }
    }
    assert!(cases >= 17);
}

#[test]
fn never_invents_an_outgoing_asset_for_a_profitable_mainnet_round_trip() {
    let folder = root().join("swap-through-dlmm");
    let (wallet, tx, activity) = fixture(&folder, &folder.join("tx-1.json"));
    assert_ne!(activity.pool_swaps.len(), 0);
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert!(
        entries
            .iter()
            .all(|entry| !matches!(entry.kind, EntryKind::SwapOut | EntryKind::SwapIn))
    );
    assert!(entries.iter().any(|entry| entry.asset
        == Asset::Token {
            mint: binsight_solana::well_known::WSOL_MINT
        }
        && entry.amount == 30_749
        && matches!(entry.kind, EntryKind::ProtocolActivity { .. })));
}

#[test]
fn charges_the_payer_of_another_wallets_automation_only_its_network_fees() {
    let folder = root().join("v0-add-liquidity-alt");
    let (wallet, tx, activity) = fixture(&folder, &folder.join("tx-1.json"));
    assert_ne!(activity.movements.len(), 0);
    assert!(
        tx.token_balances
            .iter()
            .all(|balance| balance.owner_pre != Some(wallet.wallet)
                && balance.owner_post != Some(wallet.wallet))
    );
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().all(|entry| entry.asset == Asset::Sol
        && matches!(entry.kind, EntryKind::NetworkFee | EntryKind::PriorityFee)));
    assert_eq!(
        entries.iter().map(|entry| entry.amount).sum::<i128>(),
        -i128::from(tx.fee.total.0)
    );
}

#[test]
fn resolves_the_mints_of_every_nonzero_public_position_movement() {
    for folder in std::fs::read_dir(root()).unwrap() {
        let folder = folder.unwrap().path();
        let (wallet, tx, activity) = fixture(&folder, &folder.join("tx-1.json"));
        let pools = binsight_dlmm::pool_tokens::PoolTokens::of(&tx);
        for movement in activity.movements {
            let mints = pools.mints_of(&tx, &movement);
            if movement.x.0 > 0 {
                assert!(mints.x.is_some(), "{}: {}", folder.display(), wallet.wallet);
            }
            if movement.y.0 > 0 {
                assert!(mints.y.is_some(), "{}: {}", folder.display(), wallet.wallet);
            }
        }
    }
}

#[test]
fn a_public_close_proves_ownership_and_separates_withdrawal_fees_and_unwrap() {
    let folder = root().join("claim-fee2-with-claim-fee");
    let (wallet, tx, activity) = fixture(&folder, &folder.join("tx-1.json"));
    assert!(activity.lifecycle.iter().any(|fact| matches!(fact,
        binsight_dlmm::activity::LifecycleFact::Closed { owner, .. } if *owner == wallet.wallet)));
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert!(entries.iter().any(|entry| entry.amount == 2_100_280_970
        && matches!(entry.kind, EntryKind::PositionWithdrawal { .. })));
    let mut fees: Vec<_> = entries
        .iter()
        .filter(|entry| matches!(entry.kind, EntryKind::FeeClaim { .. }))
        .map(|entry| entry.amount)
        .collect();
    fees.sort_unstable();
    assert_eq!(fees, [1_086_825, 203_206_129]);
    assert!(entries.iter().any(|entry| entry.asset == Asset::Sol
        && entry.amount == 2_101_367_795
        && entry.kind == EntryKind::Unwrap));
    assert!(entries.iter().all(|entry| !matches!(
        entry.kind,
        EntryKind::ProtocolActivity { .. }
            | EntryKind::CapitalDeposit { .. }
            | EntryKind::CapitalWithdrawal { .. }
            | EntryKind::SwapIn
            | EntryKind::SwapOut
    )));
}

#[test]
fn a_public_owned_close_keeps_token_2022_tax_separate_from_claims() {
    let folder = root().join("token2022-transfer-fee");
    let (wallet, tx, activity) = fixture(&folder, &folder.join("tx-1.json"));
    assert!(activity.lifecycle.iter().any(|fact| matches!(fact,
        binsight_dlmm::activity::LifecycleFact::Closed { owner, .. } if *owner == wallet.wallet)));
    let entries = book_transaction(&wallet, &tx, &activity).unwrap();
    assert!(entries.iter().any(|entry| entry.amount == 6_152_189_699
        && matches!(entry.kind, EntryKind::PositionWithdrawal { .. })));
    assert!(entries.iter().any(
        |entry| entry.amount == 33_848_069 && matches!(entry.kind, EntryKind::FeeClaim { .. })
    ));
    assert!(
        entries
            .iter()
            .any(|entry| entry.amount == -338_481 && entry.kind == EntryKind::TransferFee)
    );
    assert!(entries.iter().any(|entry| entry.amount == -5_355
        && entry.kind
            == EntryKind::Tip {
                service: LandingService::Jito
            }));
    assert!(entries.iter().all(|entry| !matches!(
        entry.kind,
        EntryKind::ProtocolActivity { .. } | EntryKind::SwapIn | EntryKind::SwapOut
    )));
}
