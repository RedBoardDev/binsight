//! Scans skip current results, stay bounded, and only read what was inserted since the last one.

use super::*;
use crate::database::test_database::{assert_queries_prepare, migrated_store};
use crate::decoded::{DecodeOutcome, DecodeRecord};
use crate::raw_tx::tests::sample_record;
use crate::store::Store;
use jiff::Timestamp;

fn scan(version: u32, after: RegistryPosition) -> DecodeScan {
    DecodeScan {
        decoder: "dlmm".to_owned(),
        decoder_version: version,
        reader_version: 1,
        after,
        limit: 2,
    }
}

async fn insert(store: &Store, seed: u8) -> Signature {
    let raw = sample_record(seed);
    store.raw_tx().insert_if_absent(raw.clone()).await.unwrap();
    raw.signature
}

async fn record(store: &Store, signature: Signature, version: u32, outcome: DecodeOutcome) {
    store
        .decoded()
        .replace_for_signature(DecodeRecord {
            signature,
            decoder: "dlmm".to_owned(),
            decoder_version: version,
            reader_version: 1,
            execution_outcome: None,
            transaction_index: None,
            outcome,
            decoded_at: Timestamp::UNIX_EPOCH,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn prepares_the_registry_queries() {
    assert_queries_prepare(&[SELECT_LAST_POSITION, SELECT_PENDING, COUNT_FAILED]).await;
}

#[tokio::test]
async fn skips_current_failed_results_but_revisits_every_old_result_on_a_version_bump() {
    let (_folder, store) = migrated_store().await;
    let failed = DecodeOutcome::Failed {
        error: "malformed".to_owned(),
    };
    for (seed, version, outcome) in [
        (1, 1, DecodeOutcome::NotApplicable),
        (2, 2, failed),
        (3, 3, DecodeOutcome::Decoded),
    ] {
        let signature = insert(&store, seed).await;
        record(&store, signature, version, outcome).await;
    }
    let at_version = |version| scan(version, RegistryPosition::START);

    let current = store.decoded().pending(at_version(2)).await.unwrap();
    assert_eq!(current.signatures, vec![Signature::from_bytes([1; 64])]);
    assert!(!current.is_truncated);
    let bumped = store.decoded().pending(at_version(3)).await.unwrap();
    assert_eq!(bumped.signatures.len(), 2);
    let unrelated = DecodeScan {
        decoder: "another".to_owned(),
        limit: 10,
        ..at_version(2)
    };
    assert_eq!(
        store
            .decoded()
            .pending(unrelated)
            .await
            .unwrap()
            .signatures
            .len(),
        3
    );
}

#[tokio::test]
async fn reads_only_the_transactions_inserted_since_the_previous_scan() {
    let (_folder, store) = migrated_store().await;
    let mut inserted = Vec::new();
    for seed in [5, 1, 4] {
        inserted.push(insert(&store, seed).await);
    }

    let first = store
        .decoded()
        .pending(scan(1, RegistryPosition::START))
        .await
        .unwrap();
    assert_eq!(first.signatures, inserted[..2]);
    assert!(first.is_truncated);
    let second = store
        .decoded()
        .pending(scan(1, first.scanned_to))
        .await
        .unwrap();
    assert_eq!(second.signatures, inserted[2..]);
    assert!(!second.is_truncated);

    let nothing_new = store
        .decoded()
        .pending(scan(1, second.scanned_to))
        .await
        .unwrap();
    assert_eq!(nothing_new.signatures, Vec::new());
    assert_eq!(nothing_new.scanned_to, second.scanned_to);
    let later = insert(&store, 0).await;
    let after_a_fetch = store
        .decoded()
        .pending(scan(1, nothing_new.scanned_to))
        .await
        .unwrap();
    assert_eq!(after_a_fetch.signatures, vec![later]);
}

#[tokio::test]
async fn moves_past_rows_already_decoded_without_returning_them() {
    let (_folder, store) = migrated_store().await;
    for seed in 1..=3 {
        let signature = insert(&store, seed).await;
        record(&store, signature, 1, DecodeOutcome::NotApplicable).await;
    }

    let scanned = store
        .decoded()
        .pending(scan(1, RegistryPosition::START))
        .await
        .unwrap();

    assert_eq!(scanned.signatures, Vec::new());
    assert!(scanned.scanned_to > RegistryPosition::START);
    let unchanged = store
        .decoded()
        .pending(DecodeScan {
            limit: 0,
            ..scan(1, scanned.scanned_to)
        })
        .await
        .unwrap();
    assert_eq!(unchanged.scanned_to, scanned.scanned_to);
}

#[tokio::test]
async fn searches_the_registry_from_the_position_instead_of_scanning_it() {
    let (_folder, store) = migrated_store().await;
    let plan = store
        .database()
        .read(|connection| {
            let mut query = connection.prepare(&format!("EXPLAIN QUERY PLAN {SELECT_PENDING}"))?;
            let rows = query.query_map(params!["dlmm", 1, 10, 20, 500, 1], |row| {
                row.get::<_, String>(3)
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap();
    assert!(
        plan.iter()
            .any(|step| step.contains("SEARCH raw") && step.contains("rowid>?")),
        "{plan:?}"
    );
    assert!(plan.iter().all(|step| !step.contains("SCAN")), "{plan:?}");
}

#[tokio::test]
async fn revisits_every_result_of_an_older_reader_and_counts_the_failures() {
    let (_folder, store) = migrated_store().await;
    let failed = DecodeOutcome::Failed {
        error: "unreadable".to_owned(),
    };
    for (seed, outcome) in [(1, failed), (2, DecodeOutcome::Decoded)] {
        let signature = insert(&store, seed).await;
        record(&store, signature, 2, outcome).await;
    }

    let newer_reader = DecodeScan {
        reader_version: 2,
        limit: 10,
        ..scan(2, RegistryPosition::START)
    };

    assert_eq!(
        store
            .decoded()
            .pending(scan(2, RegistryPosition::START))
            .await
            .unwrap()
            .signatures,
        Vec::new()
    );
    assert_eq!(
        store
            .decoded()
            .pending(newer_reader)
            .await
            .unwrap()
            .signatures
            .len(),
        2
    );
    assert_eq!(store.decoded().failed_count().await.unwrap(), 1);
}

#[tokio::test]
async fn counts_the_failures_from_their_index() {
    let (_folder, store) = migrated_store().await;
    let plan = store
        .database()
        .read(|connection| {
            let mut query = connection.prepare(&format!("EXPLAIN QUERY PLAN {COUNT_FAILED}"))?;
            let rows = query.query_map([], |row| row.get::<_, String>(3))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap();
    assert!(
        plan.iter().any(|step| step.contains("tx_decode_failed")),
        "{plan:?}"
    );
}
