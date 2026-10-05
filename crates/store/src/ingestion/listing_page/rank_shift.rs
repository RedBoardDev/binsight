//! Inserting a wallet-local listing ordinal without changing any immutable raw transaction.
//!
//! The newly ranked signature already occupies its requested ordinal. Other ranked signatures
//! at or after it move one place, in the same transaction as the page and cursor. SQL loads and
//! stores these metadata; checked Rust arithmetic computes their new ordinals.

use rusqlite::{Connection, params};

use crate::database::codec::{u32_from_sql, unsigned_from_sql, unsigned_to_sql};
use crate::error::StoreError;
use crate::ingestion::ListedSignature;

const SELECT_OLDER: &str = "
    SELECT signature, slot_order FROM wallet_signature
    WHERE wallet = ?1 AND slot = ?2 AND slot_order >= ?3 AND signature != ?4";
const UPDATE_RANK: &str = "
    UPDATE wallet_signature SET slot_order = ?3 WHERE wallet = ?1 AND signature = ?2";
const SELECT_RANKED_SLOT: &str = "
    SELECT slot FROM wallet_signature
    WHERE wallet = ?1 AND signature = ?2 AND slot_order IS NOT NULL";

pub(super) fn check_listed_slot(
    connection: &Connection,
    wallet: &str,
    listed: &ListedSignature,
) -> Result<(), StoreError> {
    use rusqlite::OptionalExtension;

    let stored: Option<i64> = connection
        .query_row(
            SELECT_RANKED_SLOT,
            params![wallet, listed.signature.to_string()],
            |row| row.get(0),
        )
        .optional()?;
    let Some(stored) = stored else {
        return Ok(());
    };
    let expected = unsigned_from_sql(stored, "slot")?;
    if expected != listed.slot {
        return Err(StoreError::ListedSlotConflict {
            expected,
            actual: listed.slot,
        });
    }
    Ok(())
}

pub(super) fn reserve_rank(
    connection: &Connection,
    wallet: &str,
    listed: &ListedSignature,
) -> Result<(), StoreError> {
    let Some(rank) = listed.slot_order else {
        return Ok(());
    };
    let slot = unsigned_to_sql(listed.slot, "slot")?;
    let signature = listed.signature.to_string();
    let mut query = connection.prepare_cached(SELECT_OLDER)?;
    let rows = query.query_map(params![wallet, slot, i64::from(rank), signature], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let shifts = rows
        .map(|row| {
            let (signature, stored) = row?;
            let rank = u32_from_sql(stored, "slot order")?;
            let next = rank
                .checked_add(1)
                .ok_or_else(|| StoreError::ValueTooLarge {
                    what: "slot order",
                    value: format!("{rank} + 1"),
                })?;
            Ok((signature, next))
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let mut update = connection.prepare_cached(UPDATE_RANK)?;
    for (signature, next) in shifts {
        update.execute(params![wallet, signature, i64::from(next)])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_database::{assert_queries_prepare, migrated_store};

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[SELECT_OLDER, UPDATE_RANK, SELECT_RANKED_SLOT]).await;
    }

    #[tokio::test]
    async fn ordinal_lookup_searches_one_slot_instead_of_scanning_the_wallet_history() {
        let (_folder, store) = migrated_store().await;
        let database = store.signatures().database;
        let details = database
            .read(|connection| {
                let mut query =
                    connection.prepare(&format!("EXPLAIN QUERY PLAN {SELECT_OLDER}"))?;
                let rows = query.query_map(params!["wallet", 20, 0, "signature"], |row| {
                    row.get::<_, String>(3)
                })?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
            .await
            .unwrap();
        assert!(
            details
                .iter()
                .any(|detail| detail.contains("SEARCH wallet_signature")
                    && detail.contains("wallet_signature_by_slot_order")
                    && detail.contains("slot=?"))
        );
        assert!(details.iter().all(|detail| !detail.contains("SCAN")));
    }
}
