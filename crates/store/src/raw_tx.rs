//! Layer 1: the registry of raw transactions, exactly as the RPC node returned them.
//!
//! A transaction is stored once per signature and never changed afterwards (a trigger refuses any
//! update), so everything derived from it can be recomputed locally without asking the chain
//! again. This module stores and reads rows; it does not fetch, decompress or interpret payloads.

mod attributes;

pub use attributes::PayloadCompression;

use binsight_solana::transaction::{TxEncoding, TxVersion};
use binsight_solana::{Commitment, Signature};
use jiff::Timestamp;
use rusqlite::{OptionalExtension, Row, params};

use crate::codec::{timestamp_from_sql, timestamp_to_sql, unsigned_from_sql, unsigned_to_sql};
use crate::error::StoreError;
use crate::pools::Database;
use crate::store::Store;
use attributes::{
    commitment_from_sql, commitment_to_sql, compression_from_sql, compression_to_sql,
    encoding_from_sql, encoding_to_sql, invalid, tx_version_from_sql, tx_version_to_sql,
};

const INSERT_IF_ABSENT: &str = "
    INSERT INTO raw_tx (signature, slot, block_time, tx_version, commitment, encoding,
                        compression, payload, payload_sha256, fetched_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    ON CONFLICT (signature) DO NOTHING";
const SELECT_BY_SIGNATURE: &str = "
    SELECT slot, block_time, tx_version, commitment, encoding, compression, payload,
           payload_sha256, fetched_at
    FROM raw_tx WHERE signature = ?1";
const COUNT: &str = "SELECT count(*) FROM raw_tx";

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
    /// Returns whether it was stored.
    ///
    /// # Errors
    ///
    /// Returns an error if a value does not fit its column or the database cannot be written.
    pub async fn insert_if_absent(&self, record: RawTxRecord) -> Result<bool, StoreError> {
        self.database
            .write(move |connection| {
                let inserted = connection.execute(
                    INSERT_IF_ABSENT,
                    params![
                        record.signature.to_string(),
                        unsigned_to_sql(record.slot, "slot")?,
                        record.block_time.map(timestamp_to_sql),
                        tx_version_to_sql(record.tx_version),
                        commitment_to_sql(record.commitment),
                        encoding_to_sql(record.encoding),
                        compression_to_sql(record.compression),
                        record.payload,
                        record.payload_sha256.as_slice(),
                        timestamp_to_sql(record.fetched_at),
                    ],
                )?;
                Ok(inserted == 1)
            })
            .await
    }

    /// The transaction with this signature, if it is in the registry.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn get(&self, signature: Signature) -> Result<Option<RawTxRecord>, StoreError> {
        self.database
            .read(move |connection| {
                connection
                    .query_row(SELECT_BY_SIGNATURE, [signature.to_string()], |row| {
                        Ok(record_from_row(signature, row))
                    })
                    .optional()?
                    .transpose()
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

/// Builds a record from a row of [`SELECT_BY_SIGNATURE`].
fn record_from_row(signature: Signature, row: &Row<'_>) -> Result<RawTxRecord, StoreError> {
    let sha256: Vec<u8> = row.get(7)?;
    Ok(RawTxRecord {
        signature,
        slot: unsigned_from_sql(row.get(0)?, "slot")?,
        block_time: row
            .get::<_, Option<i64>>(1)?
            .map(timestamp_from_sql)
            .transpose()?,
        tx_version: tx_version_from_sql(&row.get::<_, String>(2)?)?,
        commitment: commitment_from_sql(&row.get::<_, String>(3)?)?,
        encoding: encoding_from_sql(&row.get::<_, String>(4)?)?,
        compression: compression_from_sql(&row.get::<_, String>(5)?)?,
        payload: row.get(6)?,
        payload_sha256: sha256
            .try_into()
            .map_err(|_| invalid("payload checksum", "not 32 bytes"))?,
        fetched_at: timestamp_from_sql(row.get(8)?)?,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::test_database::{assert_queries_prepare, migrated_store};

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
}
