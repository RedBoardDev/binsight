//! Database backups: consistent copies made with `VACUUM INTO`, and their rotation.
//!
//! A backup is a complete, compacted SQLite file named
//! `binsight-<UTC time>-v<binary version>-schema<schema version>.db`, readable only by its owner.
//! `VACUUM INTO` copies a consistent snapshot even while the server keeps reading. Rotation only
//! ever deletes files whose name matches that exact pattern, so nothing else in the folder is at
//! risk. This module decides names and copies files; when to back up is decided by the upgrade.

use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};

use jiff::Timestamp;
use rusqlite::Connection;

use crate::error::StoreError;

/// Every backup file name starts with this.
const FILE_PREFIX: &str = "binsight-";

/// Every backup file name ends with this.
const FILE_SUFFIX: &str = ".db";

/// The UTC time in a backup file name; it sorts in chronological order.
const TIME_FORMAT: &str = "%Y%m%dT%H%M%SZ";

/// The length of a formatted [`TIME_FORMAT`], such as `20261003T120000Z`.
const TIME_LENGTH: usize = 16;

/// Where backups go and how many are kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupOptions {
    /// The folder that holds the backups (created if missing).
    pub folder: PathBuf,
    /// How many of the most recent backups rotation keeps.
    pub keep: usize,
}

/// The file name of a backup taken at `now` by `binary_version` of a database at `schema_version`.
pub(crate) fn backup_file_name(
    now: Timestamp,
    binary_version: &str,
    schema_version: u32,
) -> String {
    let time = now.strftime(TIME_FORMAT);
    format!("{FILE_PREFIX}{time}-v{binary_version}-schema{schema_version}{FILE_SUFFIX}")
}

/// Copies the database behind `connection` to `destination`, a file that must not exist yet.
///
/// The file is created empty with owner-only permissions first, so the copy is never readable by
/// others, not even for a moment.
pub(crate) fn write_backup(connection: &Connection, destination: &Path) -> Result<(), StoreError> {
    let backup_error = |source| StoreError::Backup {
        path: destination.to_path_buf(),
        source,
    };
    if let Some(folder) = destination.parent() {
        std::fs::create_dir_all(folder).map_err(backup_error)?;
    }
    create_private_file(destination).map_err(backup_error)?;
    let target = destination.to_str().ok_or_else(|| {
        backup_error(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the backup path is not valid UTF-8",
        ))
    })?;
    connection
        .execute("VACUUM INTO ?1", [target])
        .map_err(|error| backup_error(io::Error::other(error)))?;
    Ok(())
}

/// Deletes the oldest backups in `folder`, keeping the `keep` most recent. Returns the deleted
/// files. Files that are not backups are never touched.
pub(crate) fn rotate_backups(folder: &Path, keep: usize) -> io::Result<Vec<PathBuf>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_owned());
        }
    }
    let mut deleted = Vec::new();
    for name in backups_to_delete(names, keep) {
        let path = folder.join(name);
        std::fs::remove_file(&path)?;
        deleted.push(path);
    }
    Ok(deleted)
}

/// The backup names to delete so that only the `keep` most recent remain.
fn backups_to_delete(names: Vec<String>, keep: usize) -> Vec<String> {
    let mut backups: Vec<String> = names
        .into_iter()
        .filter(|name| is_backup_file_name(name))
        .collect();
    backups.sort();
    let excess = backups.len().saturating_sub(keep);
    backups.truncate(excess);
    backups
}

/// Whether `name` is exactly the name of a backup made by this module.
fn is_backup_file_name(name: &str) -> bool {
    let Some(rest) = name
        .strip_prefix(FILE_PREFIX)
        .and_then(|rest| rest.strip_suffix(FILE_SUFFIX))
    else {
        return false;
    };
    let Some((time, versions)) = rest.split_at_checked(TIME_LENGTH) else {
        return false;
    };
    let is_time = time
        .chars()
        .enumerate()
        .all(|(position, character)| match position {
            8 => character == 'T',
            15 => character == 'Z',
            _ => character.is_ascii_digit(),
        });
    is_time && versions.starts_with("-v") && versions.contains("-schema")
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
    use super::*;

    fn at(seconds: i64) -> Timestamp {
        Timestamp::from_second(seconds).unwrap()
    }

    #[test]
    fn names_a_backup_after_its_time_and_versions() {
        let name = backup_file_name(at(1_790_000_000), "0.1.0", 1);

        assert_eq!(name, "binsight-20260921T141320Z-v0.1.0-schema1.db");
        assert!(is_backup_file_name(&name));
    }

    #[test]
    fn recognises_only_its_own_backup_names() {
        for other in [
            "binsight.db",
            "binsight-latest.db",
            "binsight-20260921T144000Z.db",
            "binsight-20260921T144000Z-v0.1.0-schema1.db.tmp",
            "notes-20260921T144000Z-v0.1.0-schema1.db",
        ] {
            assert!(!is_backup_file_name(other), "{other}");
        }
    }

    #[test]
    fn deletes_the_oldest_backups_beyond_the_kept_count() {
        let names: Vec<String> = [3, 1, 4, 2]
            .into_iter()
            .map(|day| backup_file_name(at(1_790_000_000 + day * 86_400), "0.1.0", 1))
            .chain(["keep-me.db".to_owned()])
            .collect();

        let deleted = backups_to_delete(names, 3);

        assert_eq!(
            deleted,
            vec![backup_file_name(at(1_790_086_400), "0.1.0", 1)]
        );
    }

    #[test]
    fn deletes_nothing_when_there_are_few_backups() {
        let names = vec![backup_file_name(at(0), "0.1.0", 1)];
        assert_eq!(backups_to_delete(names, 3), Vec::<String>::new());
    }

    #[cfg(unix)]
    #[test]
    fn writes_a_backup_only_its_owner_can_read() {
        use std::os::unix::fs::PermissionsExt;

        let folder = tempfile::tempdir().unwrap();
        let connection = Connection::open(folder.path().join("binsight.db")).unwrap();
        connection
            .execute_batch("CREATE TABLE kept (x TEXT)")
            .unwrap();
        let destination = folder.path().join("backups").join("copy.db");

        write_backup(&connection, &destination).unwrap();

        let mode = std::fs::metadata(&destination)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let copy = Connection::open(&destination).unwrap();
        copy.execute_batch("SELECT * FROM kept").unwrap();
    }
}
