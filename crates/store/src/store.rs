//! The public entry point of the crate: [`Store`].
//!
//! A `Store` is a cheap handle (clone it freely) on one SQLite database file. This module opens the
//! file and checks that it answers; the schema, the migrations and the repositories are added by
//! their own modules.

use std::path::Path;

use crate::database::Database;
use crate::error::StoreError;

/// A handle on the binsight database.
///
/// Clones share the same connection pools, so every clone sees the same data and all writes are
/// still serialised through the single writer connection.
#[derive(Debug, Clone)]
pub struct Store {
    database: Database,
}

impl Store {
    /// Opens a database file that must already exist, without changing its schema.
    ///
    /// This is meant for administrative commands that inspect a database: it never creates a
    /// file, never migrates and never backs up.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] if there is no file at `path`, or another error if the
    /// file cannot be opened as a SQLite database.
    pub async fn open_existing(path: &Path) -> Result<Self, StoreError> {
        if !path.is_file() {
            return Err(StoreError::NotFound {
                path: path.to_path_buf(),
            });
        }
        let store = Self::from_database(Database::open(path)?);
        store.ping().await?;
        Ok(store)
    }

    /// Wraps pools that are already open.
    pub(crate) fn from_database(database: Database) -> Self {
        Self { database }
    }

    /// The connection pools, for the other modules of the crate.
    pub(crate) fn database(&self) -> &Database {
        &self.database
    }

    /// Checks that the database answers a trivial query on both the writer and a reader.
    ///
    /// # Errors
    ///
    /// Returns an error if no connection can be obtained or the query fails.
    pub async fn ping(&self) -> Result<(), StoreError> {
        self.database
            .write(|connection| select_one(connection))
            .await?;
        self.database.read(select_one).await
    }
}

impl Store {
    /// Copies the write-ahead log back into the database file and empties it, so the file alone
    /// holds everything. Called once at shutdown.
    ///
    /// # Errors
    ///
    /// Returns an error if the checkpoint cannot run.
    pub async fn checkpoint(&self) -> Result<(), StoreError> {
        self.database
            .write(|connection| {
                connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
                Ok(())
            })
            .await
    }
}

/// Runs `SELECT 1`, the cheapest query that proves a connection works.
fn select_one(connection: &rusqlite::Connection) -> Result<(), StoreError> {
    connection.query_row("SELECT 1", [], |_| Ok(()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refuses_to_open_a_database_that_does_not_exist() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("missing.db");

        let error = Store::open_existing(&path).await.unwrap_err();

        assert!(matches!(error, StoreError::NotFound { .. }));
        assert!(!path.exists(), "opening must not create the file");
    }

    #[tokio::test]
    async fn empties_the_write_ahead_log_on_checkpoint() {
        let (folder, store) = crate::database::test_database::migrated_store().await;
        store
            .meta()
            .set(crate::MetaKey::InstanceId, "abc".to_owned())
            .await
            .unwrap();

        store.checkpoint().await.unwrap();

        let wal = folder.path().join("binsight.db-wal");
        assert_eq!(std::fs::metadata(wal).map_or(0, |file| file.len()), 0);
    }

    #[tokio::test]
    async fn opens_an_existing_database_and_answers_a_ping() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.db");
        std::fs::File::create(&path).unwrap();

        let store = Store::open_existing(&path).await.unwrap();

        store.ping().await.unwrap();
        store.clone().ping().await.unwrap();
    }
}
