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
}
