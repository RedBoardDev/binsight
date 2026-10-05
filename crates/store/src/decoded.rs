//! Layer 2: what each decoder found in each raw transaction, tagged with the decoder version.
//!
//! The result of decoding one transaction with one decoder is replaced as a whole: the previous
//! outcome and its events are deleted and the new ones inserted in the same transaction, so a
//! reader never sees a half-written result. The transaction execution outcome is retained
//! separately from decoder success: failed instructions can have emitted events in the raw
//! payload without changing any position. Because the version is stored, a new decoder version
//! can find what it has to re-decode. This module stores results; it does not decode anything.

mod pending;
mod statements;

#[cfg(test)]
mod execution_tests;

use binsight_solana::Signature;
use binsight_solana::transaction::TxOutcome;
use jiff::Timestamp;

use crate::database::Database;
use crate::error::StoreError;
use crate::store::Store;
pub use pending::DecodeScan;
use statements::{read_record, read_snapshot, replace_record};

/// One event a decoder found in a transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedEvent {
    /// What happened, namespaced by decoder (for example `dlmm.add_liquidity`).
    pub kind: String,
    /// The event's fields as JSON, amounts written as decimal strings.
    pub payload_json: String,
}

/// What a decoder concluded about a transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeOutcome {
    /// The decoder understood the transaction; the events are in their order in the transaction.
    Decoded(Vec<DecodedEvent>),
    /// The transaction holds nothing this decoder is about.
    NotApplicable,
    /// The decoder could not read the transaction.
    Failed {
        /// Why, for whoever investigates.
        error: String,
    },
}

/// The latest result of one decoder on one transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeRecord {
    /// The decoded transaction.
    pub signature: Signature,
    /// The decoder's name (for example `dlmm`).
    pub decoder: String,
    /// The version of the decoder that produced this result (1 or more).
    pub decoder_version: u32,
    /// Whether the transaction executed successfully, independently of decoder success.
    /// `None` means an older record or an unreadable payload did not establish this fact;
    /// it must never be interpreted as a successful transaction.
    pub execution_outcome: Option<TxOutcome>,
    /// What the decoder found. A decoding failure does not imply chain execution failure.
    pub outcome: DecodeOutcome,
    /// When it ran.
    pub decoded_at: Timestamp,
}

/// Reads and writes decoding results. Get one with [`Store::decoded`].
#[derive(Debug, Clone)]
pub struct DecodedRepo {
    database: Database,
}

impl Store {
    /// The decoding results (layer 2).
    pub fn decoded(&self) -> DecodedRepo {
        DecodedRepo {
            database: self.database().clone(),
        }
    }
}

impl DecodedRepo {
    /// Replaces the result of `record.decoder` on `record.signature` with `record`, atomically.
    ///
    /// # Errors
    ///
    /// Returns an error if the raw transaction is not in the registry, or if the database cannot
    /// be written; nothing is changed then.
    pub async fn replace_for_signature(&self, record: DecodeRecord) -> Result<(), StoreError> {
        self.database
            .write(move |connection| {
                let transaction = connection.transaction()?;
                replace_record(&transaction, &record)?;
                transaction.commit()?;
                Ok(())
            })
            .await
    }

    /// The latest result of `decoder` on `signature`, if it ran.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn get(
        &self,
        signature: Signature,
        decoder: String,
    ) -> Result<Option<DecodeRecord>, StoreError> {
        self.database
            .read(move |connection| {
                read_snapshot(connection, |snapshot| {
                    read_record(snapshot, signature, decoder)
                })
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::statements::{
        DELETE_DECODE, INSERT_DECODE, INSERT_EVENT, SELECT_DECODE, SELECT_EVENTS,
    };
    use super::*;
    use crate::database::test_database::{assert_queries_prepare, migrated_store};
    use crate::raw_tx::tests::sample_record;

    fn event(kind: &str) -> DecodedEvent {
        DecodedEvent {
            kind: kind.to_owned(),
            payload_json: "{\"amount\":\"1\"}".to_owned(),
        }
    }

    fn decode_record(signature: Signature, version: u32, outcome: DecodeOutcome) -> DecodeRecord {
        DecodeRecord {
            signature,
            decoder: "dlmm".to_owned(),
            decoder_version: version,
            execution_outcome: None,
            outcome,
            decoded_at: Timestamp::from_second(1_790_000_200).unwrap(),
        }
    }

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[
            DELETE_DECODE,
            INSERT_DECODE,
            INSERT_EVENT,
            SELECT_DECODE,
            SELECT_EVENTS,
        ])
        .await;
    }

    #[tokio::test]
    async fn replaces_the_previous_result_and_its_events_as_a_whole() {
        let (_folder, store) = migrated_store().await;
        let raw = sample_record(10);
        store.raw_tx().insert_if_absent(raw.clone()).await.unwrap();
        let first = decode_record(
            raw.signature,
            1,
            DecodeOutcome::Decoded(vec![event("dlmm.a"), event("dlmm.b"), event("dlmm.c")]),
        );
        let second = decode_record(
            raw.signature,
            2,
            DecodeOutcome::Decoded(vec![event("dlmm.d")]),
        );

        store.decoded().replace_for_signature(first).await.unwrap();
        store
            .decoded()
            .replace_for_signature(second.clone())
            .await
            .unwrap();

        let stored = store
            .decoded()
            .get(raw.signature, "dlmm".to_owned())
            .await
            .unwrap();
        assert_eq!(stored, Some(second));
    }

    #[tokio::test]
    async fn keeps_the_outcome_of_a_transaction_without_events() {
        let (_folder, store) = migrated_store().await;
        let raw = sample_record(11);
        store.raw_tx().insert_if_absent(raw.clone()).await.unwrap();
        let failed = decode_record(
            raw.signature,
            1,
            DecodeOutcome::Failed {
                error: "unknown instruction".to_owned(),
            },
        );

        store
            .decoded()
            .replace_for_signature(failed.clone())
            .await
            .unwrap();

        let stored = store
            .decoded()
            .get(raw.signature, "dlmm".to_owned())
            .await
            .unwrap();
        assert_eq!(stored, Some(failed));
    }

    #[tokio::test]
    async fn refuses_a_result_for_a_transaction_not_in_the_registry() {
        let (_folder, store) = migrated_store().await;
        let orphan = decode_record(
            Signature::from_bytes([12; 64]),
            1,
            DecodeOutcome::NotApplicable,
        );

        let attempt = store.decoded().replace_for_signature(orphan).await;

        assert!(matches!(attempt, Err(StoreError::Sqlite(_))));
    }

    #[tokio::test]
    async fn has_no_result_before_the_decoder_ran() {
        let (_folder, store) = migrated_store().await;

        let stored = store
            .decoded()
            .get(Signature::from_bytes([13; 64]), "dlmm".to_owned())
            .await
            .unwrap();

        assert_eq!(stored, None);
    }
}
