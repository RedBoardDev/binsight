//! Version scans skip terminal results, remain bounded and resume in signature text order.

use super::*;
use crate::database::test_database::{assert_queries_prepare, migrated_store};
use crate::decoded::{DecodeOutcome, DecodeRecord};
use crate::raw_tx::tests::sample_record;
use jiff::Timestamp;

fn scan(version: u32) -> DecodeScan {
    DecodeScan {
        decoder: "dlmm".to_owned(),
        decoder_version: version,
        after: None,
        limit: 2,
    }
}

#[tokio::test]
async fn prepares_the_bounded_registry_query() {
    assert_queries_prepare(&[SELECT_PENDING]).await;
}

#[tokio::test]
async fn skips_current_failed_results_but_revisits_every_old_result_on_a_version_bump() {
    let (_folder, store) = migrated_store().await;
    for (number, version, outcome) in [
        (1, 1, DecodeOutcome::NotApplicable),
        (
            2,
            2,
            DecodeOutcome::Failed {
                error: "malformed".to_owned(),
            },
        ),
        (3, 3, DecodeOutcome::Decoded),
    ] {
        let raw = sample_record(number);
        store.raw_tx().insert_if_absent(raw.clone()).await.unwrap();
        store
            .decoded()
            .replace_for_signature(DecodeRecord {
                signature: raw.signature,
                decoder: "dlmm".to_owned(),
                decoder_version: version,
                execution_outcome: None,
                outcome,
                decoded_at: Timestamp::UNIX_EPOCH,
            })
            .await
            .unwrap();
    }
    assert_eq!(
        store.decoded().pending(scan(2)).await.unwrap(),
        vec![Signature::from_bytes([1; 64])]
    );
    assert_eq!(store.decoded().pending(scan(3)).await.unwrap().len(), 2);
    let unrelated = DecodeScan {
        decoder: "another".to_owned(),
        limit: 10,
        ..scan(2)
    };
    assert_eq!(store.decoded().pending(unrelated).await.unwrap().len(), 3);
}

#[tokio::test]
async fn traverses_batches_without_duplicates_and_finds_new_signatures_before_an_old_cursor() {
    let (_folder, store) = migrated_store().await;
    let mut signatures = Vec::new();
    for number in 1..=5 {
        let raw = sample_record(number);
        signatures.push(raw.signature);
        store.raw_tx().insert_if_absent(raw).await.unwrap();
    }
    signatures.sort_by_key(ToString::to_string);
    let first = store.decoded().pending(scan(2)).await.unwrap();
    let second = store
        .decoded()
        .pending(DecodeScan {
            after: first.last().copied(),
            ..scan(2)
        })
        .await
        .unwrap();
    let third = store
        .decoded()
        .pending(DecodeScan {
            after: second.last().copied(),
            ..scan(2)
        })
        .await
        .unwrap();
    assert_eq!(
        first
            .into_iter()
            .chain(second)
            .chain(third)
            .collect::<Vec<_>>(),
        signatures
    );
    let before = sample_record(0);
    store
        .raw_tx()
        .insert_if_absent(before.clone())
        .await
        .unwrap();
    let reset = DecodeScan {
        limit: 10,
        ..scan(2)
    };
    assert!(
        store
            .decoded()
            .pending(reset)
            .await
            .unwrap()
            .contains(&before.signature)
    );
    assert_eq!(
        store
            .decoded()
            .pending(DecodeScan {
                limit: 0,
                ..scan(2)
            })
            .await
            .unwrap(),
        Vec::new()
    );
}
