//! The instance metadata: a few named values stored in the `app_meta` table.
//!
//! Each value has a well-known [`MetaKey`]; there is no free-form key. This module stores and
//! returns the values as text; what a value means (a secret, a version) is up to its caller.

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::StoreError;
use crate::pools::Database;
use crate::store::Store;

const SELECT_VALUE: &str = "SELECT value FROM app_meta WHERE key = ?1";
const INSERT_VALUE_IF_ABSENT: &str =
    "INSERT INTO app_meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO NOTHING";
const UPSERT_VALUE: &str =
    "INSERT INTO app_meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2";

/// The names of the instance metadata values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetaKey {
    /// The random secret the session cookies are signed with (hexadecimal).
    SessionSecret,
    /// A random identifier of this installation (hexadecimal).
    InstanceId,
    /// The binsight version that last opened the database.
    LastStartedVersion,
}

impl MetaKey {
    /// The key as stored in the table.
    fn as_sql(self) -> &'static str {
        match self {
            Self::SessionSecret => "session_secret",
            Self::InstanceId => "instance_id",
            Self::LastStartedVersion => "last_started_version",
        }
    }
}

/// Reads and writes the instance metadata. Get one with [`Store::meta`].
#[derive(Debug, Clone)]
pub struct MetaRepo {
    database: Database,
}

impl Store {
    /// The instance metadata.
    pub fn meta(&self) -> MetaRepo {
        MetaRepo {
            database: self.database().clone(),
        }
    }
}

impl MetaRepo {
    /// The value stored under `key`, if any.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read.
    pub async fn get(&self, key: MetaKey) -> Result<Option<String>, StoreError> {
        self.database
            .read(move |connection| read_meta(connection, key))
            .await
    }

    /// Stores `value` under `key` unless a value is already there. Returns whether it was stored.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be written.
    pub async fn insert_if_absent(&self, key: MetaKey, value: String) -> Result<bool, StoreError> {
        self.database
            .write(move |connection| {
                let inserted =
                    connection.execute(INSERT_VALUE_IF_ABSENT, params![key.as_sql(), value])?;
                Ok(inserted == 1)
            })
            .await
    }

    /// Stores `value` under `key`, replacing any previous value.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be written.
    pub async fn set(&self, key: MetaKey, value: String) -> Result<(), StoreError> {
        self.database
            .write(move |connection| write_meta(connection, key, &value))
            .await
    }
}

/// Reads one value on an existing connection.
pub(crate) fn read_meta(
    connection: &Connection,
    key: MetaKey,
) -> Result<Option<String>, StoreError> {
    Ok(connection
        .query_row(SELECT_VALUE, [key.as_sql()], |row| row.get(0))
        .optional()?)
}

/// Writes one value on an existing connection (or inside the caller's transaction).
pub(crate) fn write_meta(
    connection: &Connection,
    key: MetaKey,
    value: &str,
) -> Result<(), StoreError> {
    connection.execute(UPSERT_VALUE, params![key.as_sql(), value])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_database::{assert_queries_prepare, migrated_store};

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[SELECT_VALUE, INSERT_VALUE_IF_ABSENT, UPSERT_VALUE]).await;
    }

    #[tokio::test]
    async fn has_no_value_before_one_is_stored() {
        let (_folder, store) = migrated_store().await;
        assert_eq!(store.meta().get(MetaKey::InstanceId).await.unwrap(), None);
    }

    #[tokio::test]
    async fn keeps_the_first_value_when_inserting_if_absent() {
        let (_folder, store) = migrated_store().await;
        let meta = store.meta();

        assert!(
            meta.insert_if_absent(MetaKey::SessionSecret, "first".to_owned())
                .await
                .unwrap()
        );
        assert!(
            !meta
                .insert_if_absent(MetaKey::SessionSecret, "second".to_owned())
                .await
                .unwrap()
        );

        assert_eq!(
            meta.get(MetaKey::SessionSecret).await.unwrap().as_deref(),
            Some("first")
        );
    }

    #[tokio::test]
    async fn replaces_the_value_when_setting_it() {
        let (_folder, store) = migrated_store().await;
        let meta = store.meta();
        meta.set(MetaKey::LastStartedVersion, "0.1.0".to_owned())
            .await
            .unwrap();

        meta.set(MetaKey::LastStartedVersion, "0.2.0".to_owned())
            .await
            .unwrap();

        assert_eq!(
            meta.get(MetaKey::LastStartedVersion)
                .await
                .unwrap()
                .as_deref(),
            Some("0.2.0")
        );
    }
}
