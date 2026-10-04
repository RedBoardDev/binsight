//! Database backups: consistent copies made with `VACUUM INTO`, and their rotation.
//!
//! A backup is a complete, compacted SQLite file named
//! `binsight-<UTC time>-v<binary version>-schema<schema version>.db`, readable only by its owner.
//! `VACUUM INTO` copies a consistent snapshot even while the server keeps reading. The copy is
//! written under a `.partial` name and renamed once complete, so a file with a backup name is
//! always a whole backup: a failed or interrupted copy never counts as one. Rotation only ever
//! deletes files whose name matches the backup pattern, so nothing else in the folder is at risk.
//! This module decides names and copies files; when to back up is decided by the upgrade.

mod naming;
mod rotation;

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::StoreError;
use naming::alternative_name;
pub(crate) use naming::backup_file_name;
pub(crate) use rotation::rotate_backups;

/// Appended to the name of a backup while it is being written.
const PARTIAL_SUFFIX: &str = ".partial";

/// How many backups may share the same second before the last name is reused.
const MAX_BACKUPS_PER_SECOND: u32 = 100;

/// Where backups go and how many are kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupOptions {
    /// The folder that holds the backups (created if missing).
    pub folder: PathBuf,
    /// How many of the most recent backups rotation keeps.
    pub keep: usize,
}

/// Copies the database behind `connection` to `destination` and returns the path written.
///
/// The copy goes to `<destination>.partial` first, created empty with owner-only permissions so
/// it is never readable by others, not even for a moment; it is renamed once complete, and
/// deleted if the copy fails. If `destination` already exists (two backups in the same second),
/// the backup gets the next free name (`…-2.db`, `…-3.db`…) instead of replacing it.
pub(crate) fn write_backup(
    connection: &Connection,
    destination: &Path,
) -> Result<PathBuf, StoreError> {
    let partial = write_partial_backup(connection, destination)?;
    finish_backup(&partial, &free_destination(destination))
}

/// Copies the database to `<destination>.partial` and returns that path; nothing is left behind
/// on failure.
fn write_partial_backup(
    connection: &Connection,
    destination: &Path,
) -> Result<PathBuf, StoreError> {
    let backup_error = |source| StoreError::Backup {
        path: destination.to_path_buf(),
        source,
    };
    if let Some(folder) = destination.parent() {
        std::fs::create_dir_all(folder).map_err(backup_error)?;
    }
    let partial = partial_path(destination);
    let target = partial.to_str().ok_or_else(|| {
        backup_error(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the backup path is not valid UTF-8",
        ))
    })?;
    // A copy interrupted in this very second left its partial file behind.
    discard(&partial);
    create_private_file(&partial).map_err(backup_error)?;
    if let Err(error) = connection.execute("VACUUM INTO ?1", [target]) {
        discard(&partial);
        return Err(backup_error(io::Error::other(error)));
    }
    Ok(partial)
}

/// Gives the complete copy at `partial` its backup name.
fn finish_backup(partial: &Path, destination: &Path) -> Result<PathBuf, StoreError> {
    if let Err(source) = std::fs::rename(partial, destination) {
        discard(partial);
        return Err(StoreError::Backup {
            path: destination.to_path_buf(),
            source,
        });
    }
    Ok(destination.to_path_buf())
}

/// `destination`, or the first alternative name that does not exist yet (the last one if all of
/// them do).
fn free_destination(destination: &Path) -> PathBuf {
    let Some(name) = destination.file_name().and_then(|name| name.to_str()) else {
        return destination.to_path_buf();
    };
    (1..=MAX_BACKUPS_PER_SECOND)
        .map(|attempt| match attempt {
            1 => destination.to_path_buf(),
            _ => destination.with_file_name(alternative_name(name, attempt)),
        })
        .find(|candidate| !candidate.exists())
        .unwrap_or_else(|| {
            destination.with_file_name(alternative_name(name, MAX_BACKUPS_PER_SECOND))
        })
}

/// `<path>.partial`.
fn partial_path(path: &Path) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(PARTIAL_SUFFIX);
    PathBuf::from(name)
}

/// Deletes a partial copy; one that is already gone is fine.
fn discard(partial: &Path) {
    if let Err(error) = std::fs::remove_file(partial)
        && error.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!(path = %partial.display(), %error, "could not delete a partial backup");
    }
}

/// Creates an empty file readable and writable by its owner only; fails if it already exists.
fn create_private_file(path: &Path) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).map(drop)
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;

    use super::naming::is_backup_file_name;
    use super::*;

    fn database_with_one_table(folder: &Path) -> Connection {
        let connection = Connection::open(folder.join("binsight.db")).unwrap();
        connection
            .execute_batch("CREATE TABLE kept (x TEXT)")
            .unwrap();
        connection
    }

    fn file_names(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[cfg(unix)]
    #[test]
    fn writes_a_backup_only_its_owner_can_read() {
        use std::os::unix::fs::PermissionsExt;

        let folder = tempfile::tempdir().unwrap();
        let connection = database_with_one_table(folder.path());
        let destination = folder.path().join("backups").join("copy.db");

        let written = write_backup(&connection, &destination).unwrap();

        assert_eq!(written, destination);
        let mode = std::fs::metadata(&destination)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let copy = Connection::open(&destination).unwrap();
        copy.execute_batch("SELECT * FROM kept").unwrap();
        assert_eq!(file_names(&folder.path().join("backups")), ["copy.db"]);
    }

    #[test]
    fn leaves_no_file_behind_when_the_copy_fails() {
        let folder = tempfile::tempdir().unwrap();
        let connection = database_with_one_table(folder.path());
        let backups = folder.path().join("backups");
        // SQLite refuses to VACUUM inside a transaction.
        connection.execute_batch("BEGIN").unwrap();

        let error = write_backup(&connection, &backups.join("copy.db")).unwrap_err();

        assert!(matches!(error, StoreError::Backup { .. }), "{error}");
        assert_eq!(file_names(&backups), Vec::<String>::new());
    }

    #[test]
    fn replaces_a_partial_file_left_by_an_interrupted_copy() {
        let folder = tempfile::tempdir().unwrap();
        let connection = database_with_one_table(folder.path());
        let destination = folder.path().join("copy.db");
        std::fs::write(partial_path(&destination), b"half a copy").unwrap();

        write_backup(&connection, &destination).unwrap();

        assert!(!partial_path(&destination).exists());
        Connection::open(&destination)
            .unwrap()
            .execute_batch("SELECT * FROM kept")
            .unwrap();
    }

    #[test]
    fn never_replaces_a_backup_taken_in_the_same_second() {
        let folder = tempfile::tempdir().unwrap();
        let connection = database_with_one_table(folder.path());
        let destination = folder
            .path()
            .join(backup_file_name(Timestamp::UNIX_EPOCH, "0.1.0", 1));

        let first = write_backup(&connection, &destination).unwrap();
        let second = write_backup(&connection, &destination).unwrap();

        assert_ne!(first, second);
        assert!(first.exists() && second.exists());
        let second_name = second.file_name().unwrap().to_str().unwrap();
        assert!(is_backup_file_name(second_name), "{second_name}");
    }
}
