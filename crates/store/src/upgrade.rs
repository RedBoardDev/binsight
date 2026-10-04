//! Keeping the database file safe across binsight versions: upgrades, schema status, backups.
//!
//! [`Store::open_and_upgrade`] is how `binsight run` opens the database: it creates the file if
//! needed, backs up an existing database, and applies every pending embedded migration before
//! anything else reads it. [`Store::schema_status`] reports where the schema stands without
//! changing anything, and [`Store::back_up`] makes a backup on demand, for the administrative
//! commands.

mod backup;
mod history;
mod migrate;
mod migrations;
mod procedure;

pub use backup::BackupOptions;

use std::path::{Path, PathBuf};

use jiff::Timestamp;

use crate::error::StoreError;
use crate::pools::Database;
use crate::store::Store;
use backup::{backup_file_name, write_backup};
use history::read_applied;
use migrate::plan_migrations;
use migrations::MIGRATIONS;
use procedure::upgrade;

/// What [`Store::open_and_upgrade`] needs to know about the running binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpgradeOptions {
    /// The version of the running binsight, recorded next to each migration it applies.
    pub binary_version: String,
    /// The current time, recorded next to each migration it applies and in backup names.
    pub now: Timestamp,
    /// Where the backup taken before an upgrade goes.
    pub backups: BackupOptions,
}

/// What [`Store::open_and_upgrade`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpgradeReport {
    /// The schema version found when the database was opened (0 for a new database).
    pub from_version: u32,
    /// The schema version after the upgrade.
    pub to_version: u32,
    /// The names of the migrations applied, in order (empty if the schema was up to date).
    pub applied: Vec<&'static str>,
    /// The backup of the database as it was before the upgrade, if one was needed (an identical
    /// backup left by an earlier failed start is reused rather than copied again).
    pub backup: Option<PathBuf>,
}

/// Where the schema of a database stands compared to this binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaStatus {
    /// The schema version of the database (0 if it was never migrated).
    pub current_version: u32,
    /// The latest schema version this binary knows.
    pub latest_version: u32,
    /// The names of the migrations this binary would apply, in order.
    pub pending: Vec<&'static str>,
}

impl Store {
    /// Opens the database at `path`, creating it if needed, and brings it up to date.
    ///
    /// An existing database is first backed up when migrations are pending or when a different
    /// binsight version last opened it; old backups are then rotated, before any migration runs.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::DatabaseNewerThanBinary`] or
    /// [`StoreError::MigrationChecksumMismatch`] if this binary cannot safely use the database,
    /// [`StoreError::Backup`] if the backup cannot be written (nothing is changed in these cases),
    /// [`StoreError::MigrationFailed`] if a migration fails (the database is left as it was), or
    /// another error if the file cannot be opened.
    pub async fn open_and_upgrade(
        path: &Path,
        options: UpgradeOptions,
    ) -> Result<(Self, UpgradeReport), StoreError> {
        let database = Database::open(path)?;
        let report = database
            .write(move |connection| upgrade(connection, MIGRATIONS, &options))
            .await?;
        Ok((Self::from_database(database), report))
    }

    /// Writes a backup of the database into `backups.folder`, named after `now`, the binary
    /// version and the schema version, and returns its path. Old backups are not rotated.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::Backup`] if the copy cannot be written.
    pub async fn back_up(
        &self,
        backups: &BackupOptions,
        binary_version: &str,
        now: Timestamp,
    ) -> Result<PathBuf, StoreError> {
        let folder = backups.folder.clone();
        let binary_version = binary_version.to_owned();
        self.database()
            .write(move |connection| {
                let schema = plan_migrations(MIGRATIONS, &read_applied(connection)?)?;
                let name = backup_file_name(now, &binary_version, schema.current_version);
                write_backup(connection, &folder.join(name))
            })
            .await
    }

    /// Reports the schema version of the database and the migrations still pending, without
    /// changing anything.
    ///
    /// # Errors
    ///
    /// Returns the same refusals as [`Store::open_and_upgrade`] when the database is newer than
    /// the binary or a migration was edited, or an error if the database cannot be read.
    pub async fn schema_status(&self) -> Result<SchemaStatus, StoreError> {
        self.database()
            .read(|connection| {
                let plan = plan_migrations(MIGRATIONS, &read_applied(connection)?)?;
                Ok(SchemaStatus {
                    current_version: plan.current_version,
                    latest_version: MIGRATIONS.last().map_or(0, |migration| migration.version),
                    pending: plan
                        .pending
                        .iter()
                        .map(|migration| migration.name)
                        .collect(),
                })
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(folder: &tempfile::TempDir) -> UpgradeOptions {
        UpgradeOptions {
            binary_version: "0.1.0".to_owned(),
            now: Timestamp::UNIX_EPOCH,
            backups: BackupOptions {
                folder: folder.path().join("backups"),
                keep: 3,
            },
        }
    }

    #[tokio::test]
    async fn creates_and_migrates_a_new_database() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.db");

        let (store, report) = Store::open_and_upgrade(&path, options(&folder))
            .await
            .unwrap();

        assert_eq!(report.from_version, 0);
        assert_eq!(report.to_version, 1);
        assert_eq!(report.applied, vec!["foundation"]);
        store.ping().await.unwrap();
    }

    #[tokio::test]
    async fn applies_nothing_the_second_time() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.db");
        Store::open_and_upgrade(&path, options(&folder))
            .await
            .unwrap();

        let (_store, report) = Store::open_and_upgrade(&path, options(&folder))
            .await
            .unwrap();

        assert_eq!((report.from_version, report.to_version), (1, 1));
        assert_eq!(report.applied, Vec::<&str>::new());
    }

    #[tokio::test]
    async fn reports_the_schema_of_the_embedded_migrations() {
        let folder = tempfile::tempdir().unwrap();
        let (store, _report) =
            Store::open_and_upgrade(&folder.path().join("binsight.db"), options(&folder))
                .await
                .unwrap();

        let status = store.schema_status().await.unwrap();

        assert_eq!(status.current_version, status.latest_version);
        assert_eq!(status.pending, Vec::<&str>::new());
    }

    #[tokio::test]
    async fn backs_up_on_demand_without_changing_the_database() {
        let folder = tempfile::tempdir().unwrap();
        let (store, _report) =
            Store::open_and_upgrade(&folder.path().join("binsight.db"), options(&folder))
                .await
                .unwrap();
        let backups = options(&folder).backups;

        let path = store
            .back_up(&backups, "0.1.0", Timestamp::UNIX_EPOCH)
            .await
            .unwrap();

        assert_eq!(
            path.file_name().unwrap(),
            "binsight-19700101T000000Z-v0.1.0-schema1.db"
        );
        let copy = Store::open_existing(&path).await.unwrap();
        assert_eq!(copy.schema_status().await.unwrap().current_version, 1);
    }
}
