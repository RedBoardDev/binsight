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

/// The command cannot run as invoked (`EX_USAGE`).
pub const EXIT_USAGE: u8 = 64;

/// Anything else.
pub const EXIT_UNEXPECTED: u8 = 1;

/// A command failed.
#[derive(Debug, thiserror::Error)]
pub enum Failure {
    /// The configuration is invalid; every problem is listed.
    #[error(transparent)]
    Config(#[from] ConfigError),
    /// The command cannot run as invoked; the message says what to do instead.
    #[error("{0}")]
    Usage(String),
    /// Another binsight already holds the lock of the data folder.
    #[error("another binsight is already running with the data folder {}", path.display())]
    DataDirLocked {
        /// The locked data folder.
        path: PathBuf,
    },
    /// Demo mode was started on a data folder that tracks wallets: it would mix generated figures
    /// with real ones, so it refuses.
    #[error(
        "demo mode refuses the data folder {} because it tracks wallets; demo mode keeps its data in the demo subfolder of BINSIGHT_DATA_DIR, which must not track wallets",
        path.display()
    )]
    DemoOnTrackedData {
        /// The data folder.
        path: PathBuf,
    },
    /// A wallet was to be added in demo mode, which tracks nothing.
    #[error("demo mode tracks no wallet; unset BINSIGHT_DEMO to add one to the real instance")]
    WalletInDemo,
    /// The database was written by a newer binsight, or a migration was edited; the cause says
    /// which, and what to do.
    #[error("this binsight cannot use the database, which was left untouched")]
    IncompatibleDatabase(#[source] StoreError),
    /// The database file is missing or cannot be opened (a path or permission problem).
    #[error("could not open the database")]
    DatabaseUnavailable(#[source] StoreError),
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
    /// The server did not finish stopping in time; what was left was dropped.
    #[error(
        "the shutdown took longer than {deadline_secs} seconds; the remaining work was dropped"
    )]
    ShutdownTimedOut {
        /// How long the shutdown was given.
        deadline_secs: u64,
    },
    /// The server answered its health check with an error, or not like a binsight server.
    #[error("the server is not healthy: {0}")]
    Unhealthy(String),
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
            Self::Config(_) | Self::DemoOnTrackedData { .. } | Self::WalletInDemo => EXIT_CONFIG,
            Self::Usage(_) => EXIT_USAGE,
            Self::DataDirLocked { .. } => EXIT_LOCKED,
            Self::IncompatibleDatabase(_) => EXIT_INCOMPATIBLE_DATABASE,
            Self::Io { .. } | Self::DatabaseUnavailable(_) | Self::BackupFailed(_) => EXIT_IO,
            Self::ShutdownTimedOut { .. } | Self::Unhealthy(_) | Self::Unexpected(_) => {
                EXIT_UNEXPECTED
            }
        })
    }
}

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::DatabaseNewerThanBinary { .. }
            | StoreError::MigrationChecksumMismatch { .. } => Self::IncompatibleDatabase(error),
            StoreError::Backup { .. } => Self::BackupFailed(error),
            StoreError::NotFound { .. }
            | StoreError::Create { .. }
            | StoreError::Open { .. }
            | StoreError::Connection(_) => Self::DatabaseUnavailable(error),
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
    fn treats_a_database_it_cannot_open_as_an_input_output_error() {
        let failure = Failure::from(StoreError::NotFound {
            path: PathBuf::from("/data/binsight.db"),
        });
        assert_eq!(failure.exit_code(), ExitCode::from(EXIT_IO));
    }

    #[test]
    fn never_claims_a_backup_was_made_for_a_newer_database() {
        let failure = Failure::from(StoreError::DatabaseNewerThanBinary {
            database: 9,
            binary: 1,
        });
        assert!(!failure.to_string().contains("backup"), "{failure}");
    }

    #[test]
    fn never_reports_a_forced_shutdown_as_a_clean_one() {
        let failure = Failure::ShutdownTimedOut { deadline_secs: 10 };
        assert_eq!(failure.exit_code(), ExitCode::from(EXIT_UNEXPECTED));
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
