//! Why a command failed, and the exit code each kind of failure gives the process.
//!
//! Exit codes follow the BSD `sysexits` convention, so scripts and service managers can tell a
//! configuration mistake from a busy data folder or a database from the future. This module only
//! classifies failures; reporting them is the job of `output`.

use std::path::PathBuf;
use std::process::ExitCode;

use binsight_store::StoreError;

use crate::config::ConfigError;

/// The configuration is invalid (`EX_CONFIG`).
pub const EXIT_CONFIG: u8 = 78;

/// Another binsight is using the data folder; try again later (`EX_TEMPFAIL`).
pub const EXIT_LOCKED: u8 = 75;

/// The database cannot be used by this binary (`EX_DATAERR`).
pub const EXIT_INCOMPATIBLE_DATABASE: u8 = 65;

/// A file or network operation failed (`EX_IOERR`).
pub const EXIT_IO: u8 = 74;

/// Anything else.
pub const EXIT_UNEXPECTED: u8 = 1;

/// A command failed.
#[derive(Debug, thiserror::Error)]
pub enum Failure {
    /// The configuration is invalid; every problem is listed.
    #[error(transparent)]
    Config(#[from] ConfigError),
    /// Another binsight already holds the lock of the data folder.
    #[error("another binsight is already running with the data folder {}", path.display())]
    DataDirLocked {
        /// The locked data folder.
        path: PathBuf,
    },
    /// The database was written by a newer binsight, or a migration was edited.
    #[error("this binsight cannot use the database; the latest backup is in the backups folder")]
    IncompatibleDatabase(#[source] StoreError),
    /// A file, folder or socket operation failed.
    #[error("could not {action}")]
    Io {
        /// What binsight was doing, such as `listen on 127.0.0.1:8080`.
        action: String,
        /// The underlying error.
        #[source]
        source: std::io::Error,
    },
    /// The database could not be backed up, so it was not touched.
    #[error("could not back up the database; nothing was changed")]
    BackupFailed(#[source] StoreError),
    /// Anything else, with its context.
    #[error(transparent)]
    Unexpected(#[from] anyhow::Error),
}

impl Failure {
    /// A failed file, folder or socket operation.
    pub fn io(action: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            action: action.into(),
            source,
        }
    }

    /// The process exit code for this failure.
    pub fn exit_code(&self) -> ExitCode {
        ExitCode::from(match self {
            Self::Config(_) => EXIT_CONFIG,
            Self::DataDirLocked { .. } => EXIT_LOCKED,
            Self::IncompatibleDatabase(_) => EXIT_INCOMPATIBLE_DATABASE,
            Self::Io { .. } | Self::BackupFailed(_) => EXIT_IO,
            Self::Unexpected(_) => EXIT_UNEXPECTED,
        })
    }
}

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::DatabaseNewerThanBinary { .. }
            | StoreError::MigrationChecksumMismatch { .. } => Self::IncompatibleDatabase(error),
            StoreError::Backup { .. } => Self::BackupFailed(error),
            other => Self::Unexpected(anyhow::Error::new(other).context("the database failed")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gives_a_newer_database_its_own_exit_code() {
        let failure = Failure::from(StoreError::DatabaseNewerThanBinary {
            database: 9,
            binary: 1,
        });
        assert_eq!(
            failure.exit_code(),
            ExitCode::from(EXIT_INCOMPATIBLE_DATABASE)
        );
    }

    #[test]
    fn treats_a_failed_backup_as_an_input_output_error() {
        let failure = Failure::from(StoreError::Backup {
            path: PathBuf::from("/data/backups/x.db"),
            source: std::io::Error::other("disk full"),
        });
        assert_eq!(failure.exit_code(), ExitCode::from(EXIT_IO));
    }
}
