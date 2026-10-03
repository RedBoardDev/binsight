//! Opening the database for the server: bringing its schema up to date first.
//!
//! [`Store::open_and_upgrade`] is how `binsight run` opens the database: it creates the file if
//! needed and applies every pending embedded migration before anything else reads it.
//! [`Store::schema_status`] reports the same information without changing anything, for the
//! administrative commands.

mod history;
mod migrate;
mod migrations;

use std::path::Path;

use jiff::Timestamp;

use crate::error::StoreError;
use crate::pools::Database;
use crate::store::Store;
use history::{ensure_history_table, read_applied};
use migrate::{apply_migrations, plan_migrations};
use migrations::{MIGRATIONS, Migration};

/// What [`Store::open_and_upgrade`] needs to know about the running binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpgradeOptions {
    /// The version of the running binsight, recorded next to each migration it applies.
    pub binary_version: String,
    /// The current time, recorded next to each migration it applies.
    pub now: Timestamp,
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
    /// Opens the database at `path`, creating it if needed, and applies every pending migration.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::DatabaseNewerThanBinary`] or
    /// [`StoreError::MigrationChecksumMismatch`] if this binary cannot safely use the database
    /// (nothing is changed then), [`StoreError::MigrationFailed`] if a migration fails (the
    /// database is left as it was), or another error if the file cannot be opened.
    pub async fn open_and_upgrade(
        path: &Path,
        options: UpgradeOptions,
    ) -> Result<(Self, UpgradeReport), StoreError> {
        Self::open_and_upgrade_with(path, MIGRATIONS, options).await
    }

    /// [`Store::open_and_upgrade`] with an explicit list of migrations, so tests can use their own.
    async fn open_and_upgrade_with(
        path: &Path,
        migrations: &'static [Migration],
        options: UpgradeOptions,
    ) -> Result<(Self, UpgradeReport), StoreError> {
        let database = Database::open(path)?;
        let report = database
            .write(move |connection| upgrade(connection, migrations, &options))
            .await?;
        Ok((Self::from_database(database), report))
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

/// The upgrade itself, on the writer connection.
fn upgrade(
    connection: &mut rusqlite::Connection,
    migrations: &[Migration],
    options: &UpgradeOptions,
) -> Result<UpgradeReport, StoreError> {
    ensure_history_table(connection)?;
    let plan = plan_migrations(migrations, &read_applied(connection)?)?;
    apply_migrations(
        connection,
        &plan.pending,
        &options.binary_version,
        options.now,
    )?;
    Ok(UpgradeReport {
        from_version: plan.current_version,
        to_version: plan.target_version(),
        applied: plan
            .pending
            .iter()
            .map(|migration| migration.name)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONLY: &[Migration] = &[Migration {
        version: 1,
        name: "only",
        sql: "CREATE TABLE only_table (id INTEGER PRIMARY KEY) STRICT;",
    }];

    fn options() -> UpgradeOptions {
        UpgradeOptions {
            binary_version: "0.1.0".to_owned(),
            now: Timestamp::UNIX_EPOCH,
        }
    }

    #[tokio::test]
    async fn creates_and_migrates_a_new_database() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.db");

        let (store, report) = Store::open_and_upgrade_with(&path, ONLY, options())
            .await
            .unwrap();

        assert_eq!(report.from_version, 0);
        assert_eq!(report.to_version, 1);
        assert_eq!(report.applied, vec!["only"]);
        store.ping().await.unwrap();
    }

    #[tokio::test]
    async fn applies_nothing_the_second_time() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.db");
        Store::open_and_upgrade_with(&path, ONLY, options())
            .await
            .unwrap();

        let (_store, report) = Store::open_and_upgrade_with(&path, ONLY, options())
            .await
            .unwrap();

        assert_eq!((report.from_version, report.to_version), (1, 1));
        assert_eq!(report.applied, Vec::<&str>::new());
    }

    #[tokio::test]
    async fn reports_the_schema_of_the_embedded_migrations() {
        let folder = tempfile::tempdir().unwrap();
        let (store, _report) =
            Store::open_and_upgrade(&folder.path().join("binsight.db"), options())
                .await
                .unwrap();

        let status = store.schema_status().await.unwrap();

        assert_eq!(status.current_version, status.latest_version);
        assert_eq!(status.pending, Vec::<&str>::new());
    }
}
