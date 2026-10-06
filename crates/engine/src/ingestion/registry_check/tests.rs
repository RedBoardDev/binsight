//! The startup check: what it finds and decides, and what it restores on a real database.

use binsight_core::credits::Priority;
use binsight_solana::transaction::{TxEncoding, TxVersion};
use binsight_solana::{Address, Commitment};
use binsight_store::{
    ListedSignature, ListedTop, ListingPage, PayloadCompression, RawTxRecord, RegistryInspection,
    WalletCursor, WalletInspection, WalletRepair,
};

use super::*;
use crate::test_support::{TEST_START, numbered_signature, temporary_engine};

const WALLET: Address = Address::from_bytes([1; 32]);
const OTHER: Address = Address::from_bytes([2; 32]);

fn in_step(wallet: Address) -> WalletInspection {
    WalletInspection {
        wallet,
        counted: 3,
        listed: 3,
        is_top_listed: true,
        is_history_page_listed: true,
        is_verified_point_listed: true,
    }
}

fn consistent() -> RegistryInspection {
    RegistryInspection {
        wallets: vec![in_step(WALLET), in_step(OTHER)],
        unqueued_signatures: 0,
        fetched_without_payload: 0,
        stored_but_queued: 0,
        unreturned_transactions: 0,
        outdated_decodes: 0,
        unordered_transactions: 0,
    }
}

#[test]
fn finds_nothing_and_restores_nothing_in_a_registry_in_step() {
    assert_eq!(findings_of(&consistent()), Vec::new());
    assert_eq!(restoration_of(&consistent()), Restoration::default());
}

#[test]
fn counts_again_the_wallets_whose_counter_drifted() {
    let mut inspection = consistent();
    inspection.wallets[1].counted = 7;

    assert_eq!(
        findings_of(&inspection),
        [RegistryFinding {
            kind: RegistryFindingKind::WrongListedCounts,
            count: 1
        }]
    );
    assert_eq!(restoration_of(&inspection).recount, [OTHER]);
}

#[test]
fn repairs_in_full_a_wallet_whose_cursor_or_verified_point_is_not_listed() {
    let mut inspection = consistent();
    inspection.wallets[0].is_top_listed = false;
    inspection.wallets[1].is_verified_point_listed = false;

    let restoration = restoration_of(&inspection);

    assert_eq!(restoration.repair_in_full, [WALLET, OTHER]);
    assert_eq!(
        findings_of(&inspection),
        [RegistryFinding {
            kind: RegistryFindingKind::UnlistedCursorPoints,
            count: 2
        }]
    );
}

#[test]
fn queues_and_marks_what_the_fetch_queue_lost_and_only_reports_the_rest() {
    let inspection = RegistryInspection {
        unqueued_signatures: 2,
        fetched_without_payload: 1,
        stored_but_queued: 4,
        unreturned_transactions: 5,
        outdated_decodes: 6,
        unordered_transactions: 7,
        ..consistent()
    };

    let restoration = restoration_of(&inspection);

    assert!(restoration.queue_unqueued);
    assert!(restoration.requeue_without_payload);
    assert!(restoration.mark_stored_fetched);
    assert!(restoration.recount.is_empty() && restoration.repair_in_full.is_empty());
    let kinds: Vec<(RegistryFindingKind, u64)> = findings_of(&inspection)
        .into_iter()
        .map(|finding| (finding.kind, finding.count))
        .collect();
    assert_eq!(
        kinds,
        [
            (RegistryFindingKind::UnqueuedSignatures, 2),
            (RegistryFindingKind::FetchedWithoutPayload, 1),
            (RegistryFindingKind::StoredButQueued, 4),
            (RegistryFindingKind::UnreturnedTransactions, 5),
            (RegistryFindingKind::OutdatedDecodes, 6),
            (RegistryFindingKind::UnorderedTransactions, 7),
        ]
    );
}

/// A page that lists the signature numbered `number` for [`WALLET`] and moves its cursor to a
/// top it does not list: the kind of disagreement a manual edit leaves.
fn page_with_an_unlisted_top(number: u16) -> ListingPage {
    let slot = 100_000 - u64::from(number);
    ListingPage {
        wallet: WALLET,
        signatures: vec![ListedSignature {
            signature: numbered_signature(number),
            slot,
            block_time: Some(TEST_START),
            is_failed: false,
        }],
        previous_cursor: WalletCursor::NotStarted,
        cursor: WalletCursor::HistoryComplete {
            top: Some(ListedTop {
                signature: numbered_signature(9),
                slot: slot + 1,
            }),
        },
        fetch_priority: Priority::History,
        listed_at: TEST_START,
    }
}

/// The registry row of the transaction numbered `number`.
fn stored(number: u16) -> RawTxRecord {
    RawTxRecord {
        signature: numbered_signature(number),
        slot: 100_000 - u64::from(number),
        block_time: Some(TEST_START),
        tx_version: TxVersion::V0,
        commitment: Commitment::Finalized,
        encoding: TxEncoding::Base64,
        compression: PayloadCompression::None,
        payload: b"{}".to_vec(),
        payload_sha256: [0; 32],
        fetched_at: TEST_START,
    }
}

#[tokio::test]
async fn restores_the_registry_and_asks_a_full_repair_without_any_network_call() {
    let setup = temporary_engine().await;
    let store = &setup.store;
    store.wallets().add(WALLET, TEST_START).await.unwrap();
    let page = page_with_an_unlisted_top(20);
    store.signatures().record_listing(page).await.unwrap();
    store.raw_tx().insert_if_absent(stored(20)).await.unwrap();

    let check = check_registry(store, TEST_START).await.unwrap();

    let kinds: Vec<RegistryFindingKind> =
        check.findings.iter().map(|finding| finding.kind).collect();
    assert_eq!(
        kinds,
        [
            RegistryFindingKind::UnlistedCursorPoints,
            RegistryFindingKind::StoredButQueued,
            RegistryFindingKind::OutdatedDecodes,
        ]
    );
    let asked = WalletRepair {
        wallet: WALLET,
        verified: None,
        repaired_at: None,
    };
    assert_eq!(store.repairs().list().await.unwrap(), [asked]);
    let counts = store.fetch_queue().counts(WALLET).await.unwrap();
    assert_eq!((counts.fetched, counts.pending), (1, 0));
    let again = check_registry(store, TEST_START).await.unwrap();
    let kinds: Vec<RegistryFindingKind> =
        again.findings.iter().map(|finding| finding.kind).collect();
    assert!(!kinds.contains(&RegistryFindingKind::StoredButQueued));
    assert_eq!(setup.transport.calls(), Vec::new());
}

#[tokio::test]
async fn reads_the_findings_without_restoring_anything() {
    let setup = temporary_engine().await;
    let store = &setup.store;
    store.wallets().add(WALLET, TEST_START).await.unwrap();
    store
        .signatures()
        .record_listing(page_with_an_unlisted_top(20))
        .await
        .unwrap();

    let findings = read_registry_findings(store).await.unwrap();

    assert_eq!(
        findings,
        [RegistryFinding {
            kind: RegistryFindingKind::UnlistedCursorPoints,
            count: 1
        }]
    );
    assert_eq!(store.repairs().list().await.unwrap(), Vec::new());
}
