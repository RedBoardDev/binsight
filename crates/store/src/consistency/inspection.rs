//! Reading, in one snapshot, how far the registry's facts disagree.
//!
//! Each count is one query, and none reads a payload: the walks over every listed signature,
//! every fetch task and every raw transaction follow primary keys, and the counts of open work
//! read partial indexes. The costliest walk, looking up the transaction of every fetched task,
//! only runs when the totals say a fetched task lacks its transaction: the registry holds as many
//! transactions as fetched tasks plus open tasks already stored, unless a fetched task lacks its
//! transaction (or, by an equal number, a stored transaction lacks any task; both take a manual
//! edit, and transactions are never deleted). This module only counts.

use binsight_solana::Address;
use rusqlite::{Connection, params};

use super::ConsistencyRepo;
use crate::database::codec::{parse_from_sql, unsigned_from_sql, version_to_sql};
use crate::error::StoreError;

const SELECT_WALLETS: &str = "
    SELECT c.wallet, c.listed_count,
        (SELECT count(*) FROM wallet_signature AS s WHERE s.wallet = c.wallet),
        c.top_signature IS NULL OR EXISTS (
            SELECT 1 FROM wallet_signature AS s
            WHERE s.wallet = c.wallet AND s.signature = c.top_signature),
        c.history_before IS NULL OR EXISTS (
            SELECT 1 FROM wallet_signature AS s
            WHERE s.wallet = c.wallet AND s.signature = c.history_before),
        r.verified_signature IS NULL OR EXISTS (
            SELECT 1 FROM wallet_signature AS s
            WHERE s.wallet = c.wallet AND s.signature = r.verified_signature)
    FROM wallet_cursor AS c LEFT JOIN wallet_repair AS r ON r.wallet = c.wallet
    ORDER BY c.wallet";
const COUNT_UNQUEUED: &str = "
    SELECT count(DISTINCT s.signature) FROM wallet_signature AS s
    WHERE NOT EXISTS (SELECT 1 FROM tx_fetch AS f WHERE f.signature = s.signature)";
const COUNT_FETCHED_WITHOUT_PAYLOAD: &str = "
    SELECT count(*) FROM tx_fetch AS f
    WHERE f.state = 'fetched'
      AND NOT EXISTS (SELECT 1 FROM raw_tx AS r WHERE r.signature = f.signature)";
const COUNT_TASKS: &str = "SELECT count(*) FROM tx_fetch";
const COUNT_OPEN_TASKS: &str = "SELECT count(*) FROM tx_fetch WHERE state <> 'fetched'";
const COUNT_STORED: &str = "SELECT count(*) FROM raw_tx";
const COUNT_STORED_BUT_QUEUED: &str = "
    SELECT count(*) FROM tx_fetch AS f
    WHERE f.state <> 'fetched'
      AND EXISTS (SELECT 1 FROM raw_tx AS r WHERE r.signature = f.signature)";
const COUNT_UNRETURNED: &str = "
    SELECT count(*) FROM tx_fetch WHERE state <> 'fetched' AND state IN ('empty_retry', 'failed')";
const COUNT_OUTDATED_DECODES: &str = "
    SELECT count(*) FROM raw_tx AS r
    LEFT JOIN tx_decode AS d ON d.signature = r.signature AND d.decoder = ?1
    WHERE d.decoder_version IS NULL OR d.decoder_version < ?2 OR d.reader_version < ?3";
// The partial index holds the few results without an index; SQLite would otherwise walk every
// current result through the version index.
const COUNT_UNORDERED: &str = "
    SELECT count(*) FROM tx_decode INDEXED BY tx_decode_unordered
    WHERE decoder = ?1 AND transaction_index IS NULL AND outcome <> 'failed'
      AND decoder_version >= ?2 AND reader_version >= ?3";

/// The decoder whose results are current, and the versions that make them so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentDecoder {
    /// The decoder's name (for example `dlmm`).
    pub name: String,
    /// Its current version.
    pub decoder_version: u32,
    /// The current version of the transaction reader.
    pub reader_version: u32,
}

/// How one wallet's listing bookkeeping agrees with its rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WalletInspection {
    /// The wallet.
    pub wallet: Address,
    /// How many signatures its counter says are listed.
    pub counted: u64,
    /// How many are.
    pub listed: u64,
    /// Whether its cursor's newest signature is among its listed ones (true without one).
    pub is_top_listed: bool,
    /// Whether the signature its history listing continues from is among its listed ones (true
    /// when the history is not being listed).
    pub is_history_page_listed: bool,
    /// Whether the point its last repair verified is among its listed ones (true without one).
    pub is_verified_point_listed: bool,
}

/// How far the registry's facts disagree, read in one snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryInspection {
    /// Every tracked wallet, by address.
    pub wallets: Vec<WalletInspection>,
    /// Listed signatures without a fetch task.
    pub unqueued_signatures: u64,
    /// Tasks marked fetched whose transaction is not in the registry.
    pub fetched_without_payload: u64,
    /// Transactions in the registry whose task is still open.
    pub stored_but_queued: u64,
    /// Listed transactions the node has not returned yet (still tried again).
    pub unreturned_transactions: u64,
    /// Transactions of the registry without a result of the current decoder at its current
    /// versions.
    pub outdated_decodes: u64,
    /// Transactions decoded at the current versions whose payload holds no index in its block.
    pub unordered_transactions: u64,
}

impl ConsistencyRepo {
    /// Reads how far the registry's facts disagree, all in one snapshot, judging the decoding
    /// results against `decoder`.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn inspect(&self, decoder: CurrentDecoder) -> Result<RegistryInspection, StoreError> {
        self.database
            .read(move |connection| {
                let snapshot = connection.unchecked_transaction()?;
                let inspection = inspect(&snapshot, &decoder)?;
                snapshot.commit()?;
                Ok(inspection)
            })
            .await
    }
}

fn inspect(
    connection: &Connection,
    decoder: &CurrentDecoder,
) -> Result<RegistryInspection, StoreError> {
    let versions = params![
        decoder.name,
        version_to_sql(decoder.decoder_version),
        version_to_sql(decoder.reader_version)
    ];
    let count = |query: &str, parameters: &[&dyn rusqlite::ToSql]| -> Result<u64, StoreError> {
        let count: i64 = connection.query_row(query, parameters, |row| row.get(0))?;
        unsigned_from_sql(count, "count")
    };
    let stored_but_queued = count(COUNT_STORED_BUT_QUEUED, &[])?;
    let fetched_tasks = count(COUNT_TASKS, &[])?.saturating_sub(count(COUNT_OPEN_TASKS, &[])?);
    let stored = count(COUNT_STORED, &[])?;
    let fetched_without_payload = if fetched_tasks.saturating_add(stored_but_queued) == stored {
        0
    } else {
        count(COUNT_FETCHED_WITHOUT_PAYLOAD, &[])?
    };
    Ok(RegistryInspection {
        wallets: inspect_wallets(connection)?,
        unqueued_signatures: count(COUNT_UNQUEUED, &[])?,
        fetched_without_payload,
        stored_but_queued,
        unreturned_transactions: count(COUNT_UNRETURNED, &[])?,
        outdated_decodes: count(COUNT_OUTDATED_DECODES, versions)?,
        unordered_transactions: count(COUNT_UNORDERED, versions)?,
    })
}

fn inspect_wallets(connection: &Connection) -> Result<Vec<WalletInspection>, StoreError> {
    let mut query = connection.prepare(SELECT_WALLETS)?;
    let mut rows = query.query([])?;
    let mut wallets = Vec::new();
    while let Some(row) = rows.next()? {
        wallets.push(WalletInspection {
            wallet: parse_from_sql(&row.get::<_, String>(0)?, "wallet address")?,
            counted: unsigned_from_sql(row.get(1)?, "listed count")?,
            listed: unsigned_from_sql(row.get(2)?, "count")?,
            is_top_listed: row.get(3)?,
            is_history_page_listed: row.get(4)?,
            is_verified_point_listed: row.get(5)?,
        });
    }
    Ok(wallets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_database::assert_queries_prepare;

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[
            SELECT_WALLETS,
            COUNT_UNQUEUED,
            COUNT_FETCHED_WITHOUT_PAYLOAD,
            COUNT_TASKS,
            COUNT_OPEN_TASKS,
            COUNT_STORED,
            COUNT_STORED_BUT_QUEUED,
            COUNT_UNRETURNED,
            COUNT_OUTDATED_DECODES,
            COUNT_UNORDERED,
        ])
        .await;
    }

    #[tokio::test]
    async fn counts_the_open_work_from_partial_indexes_without_walking_every_task() {
        let (_folder, store) = crate::database::test_database::migrated_store().await;
        let plans = store
            .database()
            .read(|connection| {
                let mut plans = Vec::new();
                for query in [COUNT_STORED_BUT_QUEUED, COUNT_UNRETURNED, COUNT_UNORDERED] {
                    let mut plan = connection.prepare(&format!("EXPLAIN QUERY PLAN {query}"))?;
                    let parameters = params!["dlmm", 2, 1];
                    let count = plan.parameter_count();
                    let steps: Vec<String> = if count == 0 {
                        plan.query_map([], |row| row.get(3))?
                            .collect::<Result<_, _>>()?
                    } else {
                        plan.query_map(parameters, |row| row.get(3))?
                            .collect::<Result<_, _>>()?
                    };
                    plans.push(steps.join(" / "));
                }
                Ok(plans)
            })
            .await
            .unwrap();

        assert!(plans[0].contains("tx_fetch_open"), "{plans:?}");
        assert!(plans[1].contains("tx_fetch_open"), "{plans:?}");
        assert!(plans[2].contains("tx_decode_unordered"), "{plans:?}");
    }
}
