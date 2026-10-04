//! The errors the store can return.
//!
//! One enum for the whole public surface of the crate, so callers handle every failure the
//! database can produce in one `match`. This module only describes failures; it never logs them.

use std::path::PathBuf;

/// A database operation failed.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The database file was expected to exist and does not.
    #[error("there is no database at {path}")]
    NotFound {
        /// The path that was looked up.
        path: PathBuf,
    },
    /// The database file could not be created.
    #[error("could not create the database file {path}")]
    Create {
        /// The database file.
        path: PathBuf,
        /// What the file system reported.
        #[source]
        source: std::io::Error,
    },
    /// The connection pools could not be created.
    #[error("could not prepare the database connections for {path}")]
    Open {
        /// The database file.
        path: PathBuf,
        /// What the pool builder reported.
        #[source]
        source: deadpool_sqlite::BuildError,
    },
    /// No connection could be obtained (the file could not be opened, or every connection stayed
    /// busy for too long).
    #[error("could not get a database connection")]
    Connection(#[source] deadpool_sqlite::PoolError),
    /// The blocking task that runs the SQL stopped before finishing (it panicked).
    #[error("a database task stopped before finishing")]
    TaskInterrupted,
    /// SQLite reported an error while running a statement.
    #[error("a database statement failed")]
    Sqlite(#[from] rusqlite::Error),
    /// The database was migrated by a newer binsight: this binary does not know its schema.
    #[error(
        "the database schema is at version {database} but this binsight only knows versions up \
         to {binary}; run a newer binsight or restore a backup"
    )]
    DatabaseNewerThanBinary {
        /// The schema version found in the database.
        database: u32,
        /// The latest schema version this binary knows.
        binary: u32,
    },
    /// A migration already applied to the database differs from the one embedded in the binary.
    #[error(
        "migration {version} ({name}) differs from the one applied to this database; released \
         migrations must never be edited"
    )]
    MigrationChecksumMismatch {
        /// The version of the edited migration.
        version: u32,
        /// The name of the edited migration.
        name: &'static str,
    },
    /// A migration failed; none of the pending migrations was applied.
    #[error("migration {version} ({name}) failed; the database was left unchanged")]
    MigrationFailed {
        /// The version of the failing migration.
        version: u32,
        /// The name of the failing migration.
        name: &'static str,
        /// What SQLite reported.
        #[source]
        source: rusqlite::Error,
    },
    /// A backup could not be written; when this happens before an upgrade, nothing is migrated.
    #[error("could not write the database backup {path}")]
    Backup {
        /// The backup file that could not be written.
        path: PathBuf,
        /// What failed (the folder, the file or the copy).
        #[source]
        source: std::io::Error,
    },
    /// A value is too large for the column it should be stored in.
    #[error("the {what} {value} is too large to be stored")]
    ValueTooLarge {
        /// What the value is.
        what: &'static str,
        /// The value, as text.
        value: String,
    },
    /// A projection name is not a lowercase `snake_case` identifier.
    #[error("{name:?} is not a valid projection name (lowercase letters, digits and underscores)")]
    InvalidProjectionName {
        /// The refused name.
        name: String,
    },
    /// A value read from the database is outside the range the schema allows.
    #[error("the database holds an invalid {what}: {value}")]
    InvalidStoredValue {
        /// What the value was supposed to be.
        what: &'static str,
        /// The value found, as text.
        value: String,
    },
}
