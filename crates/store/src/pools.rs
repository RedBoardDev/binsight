//! The connection pools behind the store: one writer, several read-only readers.
//!
//! SQLite allows one writer at a time. Instead of relying on locks and retries, the store has a
//! writer pool of exactly one connection, so every write is queued behind the previous one by
//! construction. Readers get their own pool and are switched to `query_only`, so a read path can
//! never modify the database by mistake. Every connection is configured once, right after it is
//! created. This module runs SQL closures on those connections; it does not contain any SQL of
//! the application.

use std::path::Path;
use std::time::Duration;

use deadpool_sqlite::{Config, Hook, HookError, Pool, Runtime};
use rusqlite::Connection;

use crate::error::StoreError;

/// The writer pool holds a single connection: this is what serialises the writes.
const WRITER_POOL_SIZE: usize = 1;

/// How many read-only connections may be open at the same time.
const READER_POOL_SIZE: usize = 4;

/// How long SQLite waits for a lock held by another connection before giving up.
const BUSY_TIMEOUT_MILLIS: u32 = 5_000;

/// How long a caller waits for a free connection before getting an error.
const POOL_WAIT_TIMEOUT_SECS: u64 = 30;

/// What a pooled connection is allowed to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionRole {
    /// The single connection that writes.
    Writer,
    /// A connection that may only read.
    Reader,
}

/// The two connection pools of one database file.
#[derive(Debug, Clone)]
pub(crate) struct Database {
    writer: Pool,
    readers: Pool,
}

impl Database {
    /// Prepares the pools for the database at `path`. Connections are opened lazily, on first
    /// use. A missing file is created first, readable by its owner only: it holds the session
    /// secret and the wallets, and SQLite would create it with the process umask (usually
    /// readable by everyone). Its write-ahead log files take the same permissions.
    pub(crate) fn open(path: &Path) -> Result<Self, StoreError> {
        create_private_file_if_missing(path).map_err(|source| StoreError::Create {
            path: path.to_path_buf(),
            source,
        })?;
        Ok(Self {
            writer: build_pool(path, ConnectionRole::Writer)?,
            readers: build_pool(path, ConnectionRole::Reader)?,
        })
    }

    /// Runs `work` on the writer connection, after every write queued before it.
    pub(crate) async fn write<T, F>(&self, work: F) -> Result<T, StoreError>
    where
        F: FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
        T: Send + 'static,
    {
        let connection = self.writer.get().await.map_err(StoreError::Connection)?;
        connection
            .interact(work)
            .await
            .map_err(|_| StoreError::TaskInterrupted)?
    }

    /// Runs `work` on a read-only connection.
    pub(crate) async fn read<T, F>(&self, work: F) -> Result<T, StoreError>
    where
        F: FnOnce(&Connection) -> Result<T, StoreError> + Send + 'static,
        T: Send + 'static,
    {
        let connection = self.readers.get().await.map_err(StoreError::Connection)?;
        connection
            .interact(|connection| work(connection))
            .await
            .map_err(|_| StoreError::TaskInterrupted)?
    }
}

/// Builds the pool for one role; every new connection is configured before it is handed out.
fn build_pool(path: &Path, role: ConnectionRole) -> Result<Pool, StoreError> {
    let size = match role {
        ConnectionRole::Writer => WRITER_POOL_SIZE,
        ConnectionRole::Reader => READER_POOL_SIZE,
    };
    let open_error = |source| StoreError::Open {
        path: path.to_path_buf(),
        source,
    };
    let builder = match Config::new(path).builder(Runtime::Tokio1) {
        Ok(builder) => builder,
        Err(never) => match never {},
    };
    builder
        .max_size(size)
        .wait_timeout(Some(Duration::from_secs(POOL_WAIT_TIMEOUT_SECS)))
        .post_create(configure_new_connections(role))
        .build()
        .map_err(open_error)
}

/// The hook that applies [`configure_connection`] to each connection the pool creates.
fn configure_new_connections(role: ConnectionRole) -> Hook {
    Hook::async_fn(move |connection, _metrics| {
        Box::pin(async move {
            connection
                .interact(move |connection| configure_connection(connection, role))
                .await
                .map_err(|_| HookError::message("the connection setup task stopped"))?
                .map_err(HookError::Backend)
        })
    })
}

/// Sets the per-connection options. The writer also switches the file to write-ahead logging
/// (a setting stored in the file); readers are made read-only.
fn configure_connection(connection: &Connection, role: ConnectionRole) -> rusqlite::Result<()> {
    if role == ConnectionRole::Writer {
        connection.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
    }
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "busy_timeout", BUSY_TIMEOUT_MILLIS)?;
    connection.pragma_update(None, "temp_store", "MEMORY")?;
    if role == ConnectionRole::Reader {
        connection.pragma_update(None, "query_only", "ON")?;
    }
    Ok(())
}

/// Creates an empty file at `path`, readable and writable by its owner only, unless a file is
/// already there.
fn create_private_file_if_missing(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    match options.open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_pragma<T: rusqlite::types::FromSql>(
        connection: &Connection,
        name: &str,
    ) -> Result<T, StoreError> {
        Ok(connection.pragma_query_value(None, name, |row| row.get(0))?)
    }

    #[tokio::test]
    async fn switches_the_database_to_write_ahead_logging() {
        let folder = tempfile::tempdir().unwrap();
        let database = Database::open(&folder.path().join("binsight.db")).unwrap();

        let writer_mode = database
            .write(|connection| read_pragma::<String>(connection, "journal_mode"))
            .await
            .unwrap();
        let reader_mode = database
            .read(|connection| read_pragma::<String>(connection, "journal_mode"))
            .await
            .unwrap();

        assert_eq!(writer_mode, "wal");
        assert_eq!(reader_mode, "wal");
    }

    #[tokio::test]
    async fn refuses_a_write_through_a_reader() {
        let folder = tempfile::tempdir().unwrap();
        let database = Database::open(&folder.path().join("binsight.db")).unwrap();
        database
            .write(|connection| Ok(connection.execute_batch("CREATE TABLE note (body TEXT)")?))
            .await
            .unwrap();

        let attempt = database
            .read(|connection| Ok(connection.execute("INSERT INTO note VALUES ('x')", [])?))
            .await;

        assert!(matches!(attempt, Err(StoreError::Sqlite(_))));
    }

    #[tokio::test]
    async fn enforces_foreign_keys_on_every_connection() {
        let folder = tempfile::tempdir().unwrap();
        let database = Database::open(&folder.path().join("binsight.db")).unwrap();

        let enabled = database
            .read(|connection| read_pragma::<i64>(connection, "foreign_keys"))
            .await
            .unwrap();

        assert_eq!(enabled, 1);
    }
}
