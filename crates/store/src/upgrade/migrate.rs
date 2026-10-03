//! The migration runner: decides which embedded migrations are pending and applies them.
//!
//! Before anything is applied, the runner refuses a database that is newer than the binary and a
//! migration whose content changed since it was applied. All pending migrations then run in a
//! single transaction: either every one of them is applied, or the database is left exactly as
//! it was. Reading and writing the history table is the job of `history`; this module does not
//! back anything up.

use jiff::Timestamp;
use rusqlite::{Connection, TransactionBehavior};

use super::history::{AppliedMigration, checksum, record_applied};
use super::migrations::Migration;
use crate::error::StoreError;

/// What the runner would do to bring a database up to date.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MigrationPlan {
    /// The schema version of the database now (0 for an empty database).
    pub(crate) current_version: u32,
    /// The migrations still to apply, in order.
    pub(crate) pending: Vec<Migration>,
}

impl MigrationPlan {
    /// The schema version of the database once the pending migrations are applied.
    pub(crate) fn target_version(&self) -> u32 {
        self.pending
            .last()
            .map_or(self.current_version, |migration| migration.version)
    }
}

/// Compares the embedded migrations with the applied ones and lists what is pending.
///
/// Refuses a database that went further than the binary knows, and a migration whose embedded
/// SQL no longer matches the checksum recorded when it was applied.
pub(crate) fn plan_migrations(
    embedded: &[Migration],
    applied: &[AppliedMigration],
) -> Result<MigrationPlan, StoreError> {
    let latest_known = embedded.last().map_or(0, |migration| migration.version);
    let current_version = applied.iter().map(|done| done.version).max().unwrap_or(0);
    if current_version > latest_known {
        return Err(StoreError::DatabaseNewerThanBinary {
            database: current_version,
            binary: latest_known,
        });
    }
    for done in applied {
        let Some(migration) = embedded.iter().find(|known| known.version == done.version) else {
            continue;
        };
        if checksum(migration.sql) != done.sha256 {
            return Err(StoreError::MigrationChecksumMismatch {
                version: migration.version,
                name: migration.name,
            });
        }
    }
    let pending = embedded
        .iter()
        .filter(|migration| migration.version > current_version)
        .copied()
        .collect();
    Ok(MigrationPlan {
        current_version,
        pending,
    })
}

/// Applies `pending` in one transaction and records each one in the history.
///
/// If any migration fails, nothing is applied and the error names the failing migration.
pub(crate) fn apply_migrations(
    connection: &mut Connection,
    pending: &[Migration],
    applied_by: &str,
    applied_at: Timestamp,
) -> Result<(), StoreError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for migration in pending {
        transaction
            .execute_batch(migration.sql)
            .map_err(|source| StoreError::MigrationFailed {
                version: migration.version,
                name: migration.name,
                source,
            })?;
        record_applied(&transaction, migration, applied_by, applied_at)?;
    }
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::OptionalExtension;

    use super::*;
    use crate::upgrade::history::{ensure_history_table, read_applied};

    const FIRST: Migration = Migration {
        version: 1,
        name: "first",
        sql: "CREATE TABLE first_table (id INTEGER PRIMARY KEY) STRICT;",
    };
    const SECOND: Migration = Migration {
        version: 2,
        name: "second",
        sql: "CREATE TABLE second_table (id INTEGER PRIMARY KEY) STRICT;",
    };
    const BROKEN: Migration = Migration {
        version: 2,
        name: "broken",
        sql: "CREATE TABLE second_table (id INTEGER PRIMARY KEY) STRICT; NOT SQL AT ALL;",
    };

    fn open_database() -> (tempfile::TempDir, Connection) {
        let folder = tempfile::tempdir().unwrap();
        let connection = Connection::open(folder.path().join("binsight.db")).unwrap();
        ensure_history_table(&connection).unwrap();
        (folder, connection)
    }

    fn migrate(connection: &mut Connection, embedded: &[Migration]) -> Result<u32, StoreError> {
        let plan = plan_migrations(embedded, &read_applied(connection)?)?;
        apply_migrations(connection, &plan.pending, "0.1.0", Timestamp::UNIX_EPOCH)?;
        Ok(plan.target_version())
    }

    fn table_exists(connection: &Connection, name: &str) -> bool {
        connection
            .query_row(
                "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1",
                [name],
                |_| Ok(()),
            )
            .optional()
            .unwrap()
            .is_some()
    }

    #[test]
    fn brings_an_empty_database_to_the_latest_version() {
        let (_folder, mut connection) = open_database();

        assert_eq!(migrate(&mut connection, &[FIRST, SECOND]).unwrap(), 2);

        assert!(table_exists(&connection, "first_table"));
        assert!(table_exists(&connection, "second_table"));
        assert_eq!(read_applied(&connection).unwrap().len(), 2);
    }

    #[test]
    fn does_nothing_when_the_database_is_up_to_date() {
        let (_folder, mut connection) = open_database();
        migrate(&mut connection, &[FIRST]).unwrap();

        let plan = plan_migrations(&[FIRST], &read_applied(&connection).unwrap()).unwrap();

        assert_eq!(plan.current_version, 1);
        assert_eq!(plan.pending, Vec::new());
        assert_eq!(migrate(&mut connection, &[FIRST]).unwrap(), 1);
    }

    #[test]
    fn applies_only_the_migrations_added_since_the_last_run() {
        let (_folder, mut connection) = open_database();
        migrate(&mut connection, &[FIRST]).unwrap();

        let plan = plan_migrations(&[FIRST, SECOND], &read_applied(&connection).unwrap()).unwrap();

        assert_eq!(plan.pending, vec![SECOND]);
    }

    #[test]
    fn refuses_a_database_newer_than_the_binary() {
        let (_folder, mut connection) = open_database();
        migrate(&mut connection, &[FIRST, SECOND]).unwrap();

        let error = migrate(&mut connection, &[FIRST]).unwrap_err();

        assert!(matches!(
            error,
            StoreError::DatabaseNewerThanBinary {
                database: 2,
                binary: 1
            }
        ));
    }

    #[test]
    fn refuses_a_migration_edited_after_it_was_applied() {
        let (_folder, mut connection) = open_database();
        migrate(&mut connection, &[FIRST]).unwrap();
        let edited = Migration {
            sql: "CREATE TABLE first_table (id INTEGER PRIMARY KEY, extra TEXT) STRICT;",
            ..FIRST
        };

        let error = migrate(&mut connection, &[edited]).unwrap_err();

        assert!(matches!(
            error,
            StoreError::MigrationChecksumMismatch {
                version: 1,
                name: "first"
            }
        ));
    }

    #[test]
    fn leaves_the_database_untouched_when_a_migration_fails() {
        let (_folder, mut connection) = open_database();

        let error = migrate(&mut connection, &[FIRST, BROKEN]).unwrap_err();

        assert!(matches!(
            error,
            StoreError::MigrationFailed {
                version: 2,
                name: "broken",
                ..
            }
        ));
        assert!(!table_exists(&connection, "first_table"));
        assert_eq!(read_applied(&connection).unwrap(), Vec::new());
    }
}
