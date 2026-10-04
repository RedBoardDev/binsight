//! The SQL that writes and reads one row of the `raw_tx` registry.
//!
//! These functions run on a connection the caller provides, so a row can be written inside a
//! larger transaction (completing a fetch writes the row and the fetch state together).

use binsight_solana::Signature;
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::RawTxRecord;
use super::attributes::{
    commitment_from_sql, commitment_to_sql, compression_from_sql, compression_to_sql,
    encoding_from_sql, encoding_to_sql, invalid, tx_version_from_sql, tx_version_to_sql,
};
use crate::database::codec::{
    timestamp_from_sql, timestamp_to_sql, unsigned_from_sql, unsigned_to_sql,
};
use crate::error::StoreError;

pub(super) const INSERT_IF_ABSENT: &str = "
    INSERT INTO raw_tx (signature, slot, block_time, tx_version, commitment, encoding,
                        compression, payload, payload_sha256, fetched_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    ON CONFLICT (signature) DO NOTHING";
pub(super) const SELECT_BY_SIGNATURE: &str = "
    SELECT slot, block_time, tx_version, commitment, encoding, compression, payload,
           payload_sha256, fetched_at
    FROM raw_tx WHERE signature = ?1";
pub(super) const COUNT: &str = "SELECT count(*) FROM raw_tx";

/// Stores `record` unless its signature is already there. Returns whether it was stored.
pub(crate) fn insert_record(
    connection: &Connection,
    record: &RawTxRecord,
) -> Result<bool, StoreError> {
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
}

/// The row of `signature`, if there is one.
pub(super) fn read_record(
    connection: &Connection,
    signature: Signature,
) -> Result<Option<RawTxRecord>, StoreError> {
    connection
        .query_row(SELECT_BY_SIGNATURE, [signature.to_string()], |row| {
            Ok(record_from_row(signature, row))
        })
        .optional()?
        .transpose()
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
