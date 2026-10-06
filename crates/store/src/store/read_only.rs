//! Telling whether a database file tracks wallets without opening it for good.
//!
//! Demo mode must refuse a data folder that tracks wallets before it locks, backs up or migrates
//! anything there. This module reads the file read-only and changes nothing on disk; opening a
//! database for use is the job of [`Store::open_and_upgrade`].

use std::path::Path;

use super::Store;
use crate::error::StoreError;

const SELECT_HAS_WALLET_TABLE: &str =
    "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'wallet')";
const SELECT_HAS_WALLET: &str = "SELECT EXISTS (SELECT 1 FROM wallet)";

impl Store {
    /// Whether the database file at `path` tracks at least one wallet, read without changing
    /// anything: the file is opened read-only, never created, migrated or backed up, and no
    /// write-ahead log is created next to it. A missing file, or one too old to have wallets,
    /// tracks none. This is a blocking call, for the moments before a database is opened for
    /// good.
    ///
    /// # Errors
    ///
    /// Returns an error if the file exists but cannot be read as a SQLite database.
    pub fn tracks_wallets(path: &Path) -> Result<bool, StoreError> {
        if !path.is_file() {
            return Ok(false);
        }
        let connection = rusqlite::Connection::open_with_flags(
            read_only_uri(path),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )?;
        let has_table: bool =
            connection.query_row(SELECT_HAS_WALLET_TABLE, [], |row| row.get(0))?;
        if !has_table {
            return Ok(false);
        }
        Ok(connection.query_row(SELECT_HAS_WALLET, [], |row| row.get(0))?)
    }
}

/// The URI that opens `path` read-only. Without a write-ahead log beside it the file holds every
/// committed write, so it is opened as immutable, which keeps SQLite from creating the log and
/// its index; with one, SQLite must read the log, and only its index may be touched.
fn read_only_uri(path: &Path) -> String {
    let mut log = path.as_os_str().to_owned();
    log.push("-wal");
    let escaped: String = path
        .to_string_lossy()
        .chars()
        .map(|character| match character {
            '%' => "%25".to_owned(),
            '?' => "%3f".to_owned(),
            '#' => "%23".to_owned(),
            other => other.to_string(),
        })
        .collect();
    if Path::new(&log).exists() {
        format!("file:{escaped}?mode=ro")
    } else {
        format!("file:{escaped}?mode=ro&immutable=1")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tells_whether_a_live_database_tracks_wallets() {
        let (folder, store) = crate::database::test_database::migrated_store().await;
        let path = folder.path().join("binsight.db");
        let missing = folder.path().join("missing.db");
        assert!(!Store::tracks_wallets(&path).unwrap());
        assert!(!Store::tracks_wallets(&missing).unwrap());
        assert!(!missing.exists());

        let wallet = binsight_solana::Address::from_bytes([1; 32]);
        store
            .wallets()
            .add(wallet, jiff::Timestamp::UNIX_EPOCH)
            .await
            .unwrap();

        assert!(Store::tracks_wallets(&path).unwrap());
    }

    #[test]
    fn reads_a_closed_database_without_creating_or_changing_a_file() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.db");
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE wallet (address TEXT PRIMARY KEY NOT NULL);
                 INSERT INTO wallet VALUES ('a');",
            )
            .unwrap();
        connection.close().unwrap();
        let files = || {
            let mut names: Vec<_> = std::fs::read_dir(folder.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            names.sort();
            names
        };
        let (before, bytes) = (files(), std::fs::read(&path).unwrap());

        assert!(Store::tracks_wallets(&path).unwrap());
        assert_eq!((files(), std::fs::read(&path).unwrap()), (before, bytes));
    }

    #[tokio::test]
    async fn sees_no_wallet_in_a_database_without_a_schema() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.db");
        rusqlite::Connection::open(&path).unwrap();

        assert!(!Store::tracks_wallets(&path).unwrap());
    }
}
