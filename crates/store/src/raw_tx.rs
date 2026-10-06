//! Layer 1: the registry of raw transactions, exactly as the RPC node returned them.
//!
//! A transaction is stored once per signature and never changed afterwards (a trigger refuses any
//! update), so everything derived from it can be recomputed locally without asking the chain
//! again. Payloads are stored compressed, with the hash of their uncompressed bytes; this module
//! stores rows and gives payloads back intact. It does not fetch or interpret them.

mod attributes;
mod compression;
mod statements;

pub use attributes::PayloadCompression;
pub(crate) use compression::compress;
pub(crate) use statements::insert_record;

use binsight_solana::transaction::{TxEncoding, TxVersion};
use binsight_solana::{Commitment, Signature};
use jiff::Timestamp;

use crate::database::Database;
use crate::database::codec::unsigned_from_sql;
use crate::error::StoreError;
use crate::store::Store;
use compression::{StoredPayload, decompress};
use statements::{COUNT, read_record};

/// One transaction of the registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawTxRecord {
    /// The transaction signature (its identifier).
    pub signature: Signature,
    /// The slot it landed in.
    pub slot: u64,
    /// When the block was produced, if the node said so.
    pub block_time: Option<Timestamp>,
    /// The transaction format version.
    pub tx_version: TxVersion,
    /// How final it was when fetched.
    pub commitment: Commitment,
    /// The requested RPC encoding.
    pub encoding: TxEncoding,
    /// How `payload` is compressed.
    pub compression: PayloadCompression,
    /// The node's answer, as stored.
    pub payload: Vec<u8>,
    /// The SHA-256 of the uncompressed payload.
    pub payload_sha256: [u8; 32],
    /// When binsight fetched it.
    pub fetched_at: Timestamp,
}

/// Reads and writes the raw transaction registry. Get one with [`Store::raw_tx`].
#[derive(Debug, Clone)]
pub struct RawTxRepo {
    database: Database,
}

impl Store {
    /// The raw transaction registry (layer 1).
    pub fn raw_tx(&self) -> RawTxRepo {
        RawTxRepo {
            database: self.database().clone(),
        }
    }
}

impl RawTxRepo {
    /// Stores a transaction unless its signature is already there; the first copy always wins.
    /// Returns whether it was stored. Production code stores a transaction only when its fetch
    /// completes (`FetchQueueRepo::complete`); this plants a row for a test.
    ///
    /// # Errors
    ///
    /// Returns an error if a value does not fit its column or the database cannot be written.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn insert_if_absent(&self, record: RawTxRecord) -> Result<bool, StoreError> {
        self.database
            .write(move |connection| insert_record(connection, &record))
            .await
    }

    /// The transaction with this signature, if it is in the registry.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn get(&self, signature: Signature) -> Result<Option<RawTxRecord>, StoreError> {
        self.database
            .read(move |connection| read_record(connection, signature))
            .await
    }

    /// The node's answer for this signature, uncompressed and checked against its hash, if the
    /// transaction is in the registry.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::PayloadChecksumMismatch`] if the stored payload is damaged, or another
    /// error if the database cannot be read.
    pub async fn payload(&self, signature: Signature) -> Result<Option<Vec<u8>>, StoreError> {
        self.database
            .read(move |connection| {
                let Some(record) = read_record(connection, signature)? else {
                    return Ok(None);
                };
                let stored = StoredPayload {
                    compression: record.compression,
                    bytes: record.payload,
                    sha256: record.payload_sha256,
                };
                decompress(&stored).map(Some)
            })
            .await
    }

    /// How many transactions the registry holds.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read.
    pub async fn count(&self) -> Result<u64, StoreError> {
        self.database
            .read(|connection| {
                let count: i64 = connection.query_row(COUNT, [], |row| row.get(0))?;
                unsigned_from_sql(count, "row count")
            })
            .await
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::statements::{INSERT_IF_ABSENT, SELECT_BY_SIGNATURE};
    use super::*;
    use crate::database::test_database::{assert_queries_prepare, migrated_store};

    /// A plausible record whose signature is made of `seed` bytes.
    pub(crate) fn sample_record(seed: u8) -> RawTxRecord {
        RawTxRecord {
            signature: Signature::from_bytes([seed; 64]),
            slot: 300_000_000,
            block_time: Some(Timestamp::from_second(1_790_000_000).unwrap()),
            tx_version: TxVersion::V0,
            commitment: Commitment::Finalized,
            encoding: TxEncoding::Json,
            compression: PayloadCompression::None,
            payload: b"{\"slot\":300000000}".to_vec(),
            payload_sha256: [7; 32],
            fetched_at: Timestamp::from_second(1_790_000_100).unwrap(),
        }
    }

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[INSERT_IF_ABSENT, SELECT_BY_SIGNATURE, COUNT]).await;
    }

    #[tokio::test]
    async fn reads_back_a_stored_transaction_unchanged() {
        let (_folder, store) = migrated_store().await;
        let record = RawTxRecord {
            block_time: None,
            tx_version: TxVersion::Legacy,
            ..sample_record(1)
        };

        assert!(
            store
                .raw_tx()
                .insert_if_absent(record.clone())
                .await
                .unwrap()
        );

        let stored = store.raw_tx().get(record.signature).await.unwrap();
        assert_eq!(stored, Some(record));
    }

    #[tokio::test]
    async fn keeps_the_first_row_when_a_raw_tx_is_inserted_twice() {
        let (_folder, store) = migrated_store().await;
        let first = sample_record(2);
        let second = RawTxRecord {
            payload: b"another answer".to_vec(),
            ..first.clone()
        };

        assert!(
            store
                .raw_tx()
                .insert_if_absent(first.clone())
                .await
                .unwrap()
        );
        assert!(!store.raw_tx().insert_if_absent(second).await.unwrap());

        assert_eq!(
            store.raw_tx().get(first.signature).await.unwrap(),
            Some(first)
        );
        assert_eq!(store.raw_tx().count().await.unwrap(), 1);
    }

    #[tokio::test]
    async fn refuses_any_update_of_a_stored_transaction() {
        let (_folder, store) = migrated_store().await;
        store
            .raw_tx()
            .insert_if_absent(sample_record(3))
            .await
            .unwrap();

        let attempt = store
            .database()
            .write(|connection| Ok(connection.execute("UPDATE raw_tx SET slot = 1", [])?))
            .await;

        let Err(StoreError::Sqlite(error)) = attempt else {
            panic!("the update was not refused: {attempt:?}");
        };
        assert!(error.to_string().contains("raw_tx rows are immutable"));
    }

    #[tokio::test]
    async fn refuses_a_floating_point_value_in_an_integer_column() {
        let (_folder, store) = migrated_store().await;

        let attempt = store
            .database()
            .write(|connection| {
                Ok(connection.execute(
                    "INSERT INTO raw_tx VALUES ('x', 1.5, NULL, 'legacy', 'confirmed', 'json',
                     'none', x'00', zeroblob(32), 0)",
                    [],
                )?)
            })
            .await;

        assert!(matches!(attempt, Err(StoreError::Sqlite(_))));
    }

    #[tokio::test]
    async fn gives_back_the_uncompressed_payload_of_a_stored_transaction() {
        let (_folder, store) = migrated_store().await;
        let payload = br#"{"slot":300000000,"transaction":["AQID","base64"]}"#;
        let stored = compress(payload).unwrap();
        let record = RawTxRecord {
            compression: stored.compression,
            payload: stored.bytes,
            payload_sha256: stored.sha256,
            ..sample_record(4)
        };
        store.raw_tx().insert_if_absent(record).await.unwrap();

        let read = store.raw_tx().payload(Signature::from_bytes([4; 64])).await;

        assert_eq!(read.unwrap(), Some(payload.to_vec()));
        let missing = store.raw_tx().payload(Signature::from_bytes([5; 64])).await;
        assert_eq!(missing.unwrap(), None);
    }
}
