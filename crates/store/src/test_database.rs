//! Helpers for the unit tests of the repositories: a fully migrated store on a temporary file.
//!
//! Only compiled for tests. Repository tests run against a real SQLite file with the real schema,
//! never against a mock.

use jiff::Timestamp;

use crate::error::StoreError;
use crate::store::Store;
use crate::upgrade::UpgradeOptions;

/// A store migrated to the latest schema. Keep the folder alive as long as the store is used.
pub(crate) async fn migrated_store() -> (tempfile::TempDir, Store) {
    let folder = tempfile::tempdir().unwrap();
    let options = UpgradeOptions {
        binary_version: "0.1.0".to_owned(),
        now: Timestamp::UNIX_EPOCH,
    };
    let (store, _report) = Store::open_and_upgrade(&folder.path().join("binsight.db"), options)
        .await
        .unwrap();
    (folder, store)
}

/// Prepares every query against the migrated schema: a typo in a table or column name fails here
/// instead of at run time.
pub(crate) async fn assert_queries_prepare(queries: &'static [&'static str]) {
    let (_folder, store) = migrated_store().await;
    store
        .database()
        .read(move |connection| {
            for query in queries {
                connection
                    .prepare(query)
                    .map_err(|error| StoreError::InvalidStoredValue {
                        what: "query",
                        value: format!("{query}: {error}"),
                    })?;
            }
            Ok(())
        })
        .await
        .unwrap();
}
