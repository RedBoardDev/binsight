//! The data folder: created private, and locked for as long as binsight runs on it.
//!
//! Two servers writing the same database would corrupt it, so `run` takes an exclusive lock on
//! `binsight.lock` in the data folder; the operating system releases it when the process ends,
//! even after a crash. The lock is reliable on local disks and Docker volumes, not on network
//! file systems. This module only manages the folder; the database is the store's.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};

use crate::failure::Failure;

/// The lock file inside the data folder.
const LOCK_FILE: &str = "binsight.lock";

/// The database file inside the data folder.
const DATABASE_FILE: &str = "binsight.db";

/// The backups folder inside the data folder.
const BACKUPS_FOLDER: &str = "backups";

/// A data folder this process holds the lock of.
#[derive(Debug)]
pub struct LockedDataDir {
    path: PathBuf,
    // Held, never read: the lock lasts as long as this file stays open.
    _lock: File,
}

impl LockedDataDir {
    /// Creates the folder if needed (readable by its owner only) and takes its lock.
    ///
    /// # Errors
    ///
    /// Returns [`Failure::DataDirLocked`] if another process holds the lock, or an I/O failure if
    /// the folder or the lock file cannot be created.
    pub fn open(path: &Path) -> Result<Self, Failure> {
        create_private_folder(path).map_err(|error| {
            Failure::io(format!("create the data folder {}", path.display()), error)
        })?;
        let lock_path = path.join(LOCK_FILE);
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)
            .map_err(|error| Failure::io(format!("open {}", lock_path.display()), error))?;
        match lock.try_lock() {
            Ok(()) => Ok(Self {
                path: path.to_path_buf(),
                _lock: lock,
            }),
            Err(TryLockError::WouldBlock) => Err(Failure::DataDirLocked {
                path: path.to_path_buf(),
            }),
            Err(TryLockError::Error(error)) => {
                Err(Failure::io(format!("lock {}", lock_path.display()), error))
            }
        }
    }

    /// The database file.
    pub fn database_path(&self) -> PathBuf {
        self.path.join(DATABASE_FILE)
    }

    /// The folder of the backups.
    pub fn backups_path(&self) -> PathBuf {
        self.path.join(BACKUPS_FOLDER)
    }
}

/// Creates `path` and its parents; new folders are readable by their owner only.
pub(crate) fn create_private_folder(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_second_lock_on_the_same_folder() {
        let folder = tempfile::tempdir().unwrap();
        let data = folder.path().join("data");

        let first = LockedDataDir::open(&data).unwrap();
        let second = LockedDataDir::open(&data);

        assert!(matches!(second, Err(Failure::DataDirLocked { .. })));
        drop(first);
        assert!(LockedDataDir::open(&data).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn creates_the_folder_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let folder = tempfile::tempdir().unwrap();
        let data = folder.path().join("nested/data");

        let locked = LockedDataDir::open(&data).unwrap();

        let mode = std::fs::metadata(&data).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        assert_eq!(locked.database_path(), data.join("binsight.db"));
    }
}
