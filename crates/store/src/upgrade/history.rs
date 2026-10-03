//! The history of applied migrations, kept in the `schema_migrations` table.
//!
//! The table is created by the runner itself rather than by a migration, and records for each
//! applied migration its version, its name, the checksum of its SQL, when and by which binsight
//! version it was applied. This module reads and writes that table; it does not decide what to
//! apply.

use jiff::Timestamp;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::migrations::Migration;
use crate::codec::{timestamp_to_sql, version_from_sql, version_to_sql};
use crate::error::StoreError;

const CREATE_HISTORY_TABLE: &str = "
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY NOT NULL,
        name        TEXT NOT NULL,
        sha256      TEXT NOT NULL,
        applied_at  INTEGER NOT NULL,
        applied_by  TEXT NOT NULL
    ) STRICT";

const FIND_HISTORY_TABLE: &str =
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'";

const SELECT_APPLIED: &str = "SELECT version, sha256 FROM schema_migrations ORDER BY version";

const INSERT_APPLIED: &str = "
    INSERT INTO schema_migrations (version, name, sha256, applied_at, applied_by)
    VALUES (?1, ?2, ?3, ?4, ?5)";

/// A migration recorded as applied in the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppliedMigration {
    /// The schema version it produced.
    pub(crate) version: u32,
    /// The checksum of its SQL when it was applied.
    pub(crate) sha256: String,
}

/// The hexadecimal SHA-256 of a migration's SQL, as recorded in the history.
pub(crate) fn checksum(sql: &str) -> String {
    hex::encode(Sha256::digest(sql.as_bytes()))
}

/// Creates the history table if this database has never been migrated.
pub(crate) fn ensure_history_table(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch(CREATE_HISTORY_TABLE)?;
    Ok(())
}

/// The migrations recorded in the database, oldest first. A database without a history table has
/// none (this function never creates the table, so it is safe on a read-only connection).
pub(crate) fn read_applied(connection: &Connection) -> Result<Vec<AppliedMigration>, StoreError> {
    let has_history = connection
        .query_row(FIND_HISTORY_TABLE, [], |_| Ok(()))
        .optional()?
        .is_some();
    if !has_history {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(SELECT_APPLIED)?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get(1)?)))?;
    let mut applied = Vec::new();
    for row in rows {
        let (version, sha256) = row?;
        applied.push(AppliedMigration {
            version: version_from_sql(version)?,
            sha256,
        });
    }
    Ok(applied)
}

/// Records `migration` as applied, inside the caller's transaction.
pub(crate) fn record_applied(
    connection: &Connection,
    migration: &Migration,
    applied_by: &str,
    applied_at: Timestamp,
) -> Result<(), StoreError> {
    connection.execute(
        INSERT_APPLIED,
        params![
            version_to_sql(migration.version),
            migration.name,
            checksum(migration.sql),
            timestamp_to_sql(applied_at),
            applied_by,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST: Migration = Migration {
        version: 1,
        name: "first",
        sql: "",
    };

    #[test]
    fn reads_no_history_from_a_database_never_migrated() {
        let folder = tempfile::tempdir().unwrap();
        let connection = Connection::open(folder.path().join("fresh.db")).unwrap();

        assert_eq!(read_applied(&connection).unwrap(), Vec::new());
    }

    #[test]
    fn reads_back_what_was_recorded() {
        let folder = tempfile::tempdir().unwrap();
        let connection = Connection::open(folder.path().join("binsight.db")).unwrap();
        ensure_history_table(&connection).unwrap();

        record_applied(&connection, &FIRST, "0.1.0", Timestamp::UNIX_EPOCH).unwrap();

        assert_eq!(
            read_applied(&connection).unwrap(),
            vec![AppliedMigration {
                version: 1,
                sha256: checksum(""),
            }]
        );
    }

    #[test]
    fn checksums_the_sql_as_lowercase_hexadecimal_sha256() {
        assert_eq!(
            checksum(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
