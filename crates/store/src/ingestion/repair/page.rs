//! Writing what a repair listing found: the gaps it fills and the fetches it brings forward.
//!
//! A repair lists signatures at the finalized commitment, so each one exists on chain. One the
//! wallet does not list yet is a gap: it is written with its fetch task, like a listed page, but
//! the cursor stays where it is (only the listing worker moves it). A task is never queued for a
//! transaction the registry already holds: it is marked fetched instead. A listed signature
//! whose fetch keeps coming back empty is brought forward: the node lists it, so it should
//! return it now. Everything is one transaction. This module applies the engine's decisions.

use binsight_core::credits::Priority;
use binsight_solana::Address;
use jiff::Timestamp;
use rusqlite::{Connection, params};

use super::state::RepairsRepo;
use crate::database::codec::{flag_to_sql, timestamp_to_sql, unsigned_to_sql};
use crate::error::StoreError;
use crate::ingestion::ListedSignature;

const INSERT_SIGNATURE: &str = "
    INSERT INTO wallet_signature (wallet, signature, slot, block_time, is_failed, listed_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (wallet, signature) DO NOTHING";
const FINALIZE_SIGNATURE: &str = "
    UPDATE wallet_signature SET slot = ?3, block_time = coalesce(?4, block_time), is_failed = ?5
    WHERE wallet = ?1 AND signature = ?2";
const INSERT_STORED_TASK: &str = "
    INSERT INTO tx_fetch (signature, state, priority, slot, attempts, next_attempt_at,
                          last_error, updated_at)
    SELECT ?1, 'fetched', ?2, ?3, 0, NULL, NULL, ?4
    WHERE EXISTS (SELECT 1 FROM raw_tx WHERE signature = ?1)
    ON CONFLICT (signature) DO NOTHING";
const INSERT_TASK: &str = "
    INSERT INTO tx_fetch (signature, state, priority, slot, attempts, next_attempt_at,
                          last_error, updated_at)
    VALUES (?1, 'pending', ?2, ?3, 0, ?4, NULL, ?4)
    ON CONFLICT (signature) DO NOTHING";
const BRING_FORWARD: &str = "
    UPDATE tx_fetch
    SET state = 'pending', attempts = 0, next_attempt_at = ?3, updated_at = ?3,
        priority = CASE WHEN priority = 'realtime' THEN 'realtime' ELSE ?2 END
    WHERE signature = ?1 AND state IN ('empty_retry', 'failed')";
const COUNT_FOUND: &str =
    "UPDATE wallet_cursor SET listed_count = listed_count + ?2 WHERE wallet = ?1";

/// Signatures a repair listed for a wallet, at the finalized commitment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepairPage {
    /// The wallet.
    pub wallet: Address,
    /// The signatures listed.
    pub signatures: Vec<ListedSignature>,
    /// How urgent fetching the missing ones is.
    pub fetch_priority: Priority,
    /// When they were listed; the new tasks are due from then.
    pub listed_at: Timestamp,
}

/// What a repair page changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RepairFindings {
    /// Signatures the wallet did not list: the gaps, now listed and queued.
    pub missing: u64,
    /// Listed signatures whose fetch kept coming back empty, now due again.
    pub brought_forward: u64,
}

impl RepairsRepo {
    /// Writes what a repair listed: each signature the wallet lacks, with its fetch task (or
    /// marked fetched if the registry holds its transaction), and each empty fetch of a listed
    /// signature brought forward to `page.listed_at`. The cursor is left as it is.
    ///
    /// # Errors
    ///
    /// Returns an error if the wallet is not tracked or the database cannot be written; nothing
    /// is written then.
    pub async fn record_page(&self, page: RepairPage) -> Result<RepairFindings, StoreError> {
        self.database
            .write(move |connection| {
                let transaction = connection.transaction()?;
                let findings = write_page(&transaction, &page)?;
                transaction.commit()?;
                Ok(findings)
            })
            .await
    }
}

fn write_page(connection: &Connection, page: &RepairPage) -> Result<RepairFindings, StoreError> {
    let wallet = page.wallet.to_string();
    let listed_at = timestamp_to_sql(page.listed_at);
    let priority = page.fetch_priority.as_str();
    let mut findings = RepairFindings::default();
    for listed in &page.signatures {
        let signature = listed.signature.to_string();
        let slot = unsigned_to_sql(listed.slot, "slot")?;
        let block_time = listed.block_time.map(timestamp_to_sql);
        let is_failed = flag_to_sql(listed.is_failed);
        let row = params![wallet, signature, slot, block_time, is_failed, listed_at];
        if connection.execute(INSERT_SIGNATURE, row)? == 1 {
            findings.missing = findings.missing.saturating_add(1);
        } else {
            let listed_row = params![wallet, signature, slot, block_time, is_failed];
            connection.execute(FINALIZE_SIGNATURE, listed_row)?;
        }
        let task = params![signature, priority, slot, listed_at];
        connection.execute(INSERT_STORED_TASK, task)?;
        connection.execute(INSERT_TASK, task)?;
        let brought = connection.execute(BRING_FORWARD, params![signature, priority, listed_at])?;
        if brought == 1 {
            findings.brought_forward = findings.brought_forward.saturating_add(1);
        }
    }
    let counted = connection.execute(
        COUNT_FOUND,
        params![wallet, unsigned_to_sql(findings.missing, "listed count")?],
    )?;
    if counted != 1 {
        return Err(StoreError::UnknownWallet {
            address: page.wallet,
        });
    }
    Ok(findings)
}

#[cfg(test)]
mod tests;
