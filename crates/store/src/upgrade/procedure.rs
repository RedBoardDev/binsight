//! The ordered steps of an upgrade, on the writer connection.
//!
//! 1. Read the migration history and refuse a database this binary cannot use.
//! 2. Back up an existing database if migrations are pending or the binary version changed, then
//!    rotate the old backups.
//! 3. Apply the pending migrations in one transaction.
//! 4. Record the binary version.
//!
//! If the backup fails, nothing is migrated. A brand-new database is never backed up: there is
//! nothing in it to lose. Rotation comes before the migrations, so a migration that fails on
//! every start (with a restart policy, in a loop) cannot fill the disk; and a backup identical to
//! the newest one of the same versions is not written again, so those restarts do not push the
//! older backups out either.

use std::path::PathBuf;

use rusqlite::Connection;
use tracing::{info, warn};

use super::backup::{rotate_backups, write_backup_unless_identical};
use super::history::{ensure_history_table, read_applied};
use super::migrate::{MigrationPlan, apply_migrations, plan_migrations};
use super::migrations::Migration;
use super::{UpgradeOptions, UpgradeReport};
use crate::error::StoreError;
use crate::meta::{MetaKey, read_meta, write_meta};

/// Runs every step of the upgrade and reports what was done.
pub(crate) fn upgrade(
    connection: &mut Connection,
    migrations: &[Migration],
    options: &UpgradeOptions,
) -> Result<UpgradeReport, StoreError> {
    ensure_history_table(connection)?;
    let applied = read_applied(connection)?;
    let plan = plan_migrations(migrations, &applied)?;
    let is_new_database = applied.is_empty();
    let backup = if !is_new_database && needs_backup(connection, &plan, options)? {
        let path = back_up_before_upgrade(connection, &plan, options)?;
        rotate_old_backups(options);
        Some(path)
    } else {
        None
    };
    apply_migrations(
        connection,
        &plan.pending,
        &options.binary_version,
        options.now,
    )?;
    write_meta(
        connection,
        MetaKey::LastStartedVersion,
        &options.binary_version,
    )?;
    let report = UpgradeReport {
        from_version: plan.current_version,
        to_version: plan.target_version(),
        applied: plan
            .pending
            .iter()
            .map(|migration| migration.name)
            .collect(),
        backup,
    };
    if !report.applied.is_empty() {
        info!(from = report.from_version, to = report.to_version, migrations = ?report.applied, "database schema upgraded");
    }
    Ok(report)
}

/// An existing database is backed up before its schema changes, and also whenever a different
/// binary version opens it (a new version may write data an older one cannot read back).
fn needs_backup(
    connection: &Connection,
    plan: &MigrationPlan,
    options: &UpgradeOptions,
) -> Result<bool, StoreError> {
    if !plan.pending.is_empty() {
        return Ok(true);
    }
    let last_started = read_meta(connection, MetaKey::LastStartedVersion)?;
    Ok(last_started.as_deref() != Some(options.binary_version.as_str()))
}

fn back_up_before_upgrade(
    connection: &Connection,
    plan: &MigrationPlan,
    options: &UpgradeOptions,
) -> Result<PathBuf, StoreError> {
    let versions = (options.binary_version.as_str(), plan.current_version);
    let path =
        write_backup_unless_identical(connection, &options.backups.folder, options.now, versions)?;
    info!(path = %path.display(), "database backed up before the upgrade");
    Ok(path)
}

/// Old backups are only a convenience: failing to delete one is reported, not fatal.
fn rotate_old_backups(options: &UpgradeOptions) {
    match rotate_backups(&options.backups.folder, options.backups.keep) {
        Ok(deleted) => {
            for path in deleted {
                info!(path = %path.display(), "old backup deleted");
            }
        }
        Err(error) => {
            warn!(folder = %options.backups.folder.display(), %error, "could not delete old backups");
        }
    }
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;

    use super::*;
    use crate::upgrade::BackupOptions;
    use crate::upgrade::migrations::MIGRATIONS;

    const FOUNDATION: Migration = MIGRATIONS[0];
    const EXTRA: Migration = Migration {
        version: 2,
        name: "extra",
        sql: "CREATE TABLE extra (id INTEGER PRIMARY KEY) STRICT;",
    };
    const BROKEN: Migration = Migration {
        version: 2,
        name: "broken",
        sql: "NOT SQL AT ALL;",
    };

    struct Setup {
        folder: tempfile::TempDir,
        connection: Connection,
    }

    impl Setup {
        fn new() -> Self {
            let folder = tempfile::tempdir().unwrap();
            let connection = Connection::open(folder.path().join("binsight.db")).unwrap();
            Self { folder, connection }
        }

        fn options(&self, version: &str, day: i64) -> UpgradeOptions {
            UpgradeOptions {
                binary_version: version.to_owned(),
                now: Timestamp::from_second(1_790_000_000 + day * 86_400).unwrap(),
                backups: BackupOptions {
                    folder: self.folder.path().join("backups"),
                    keep: 3,
                },
            }
        }

        fn run(&mut self, migrations: &[Migration], version: &str, day: i64) -> UpgradeReport {
            let options = self.options(version, day);
            upgrade(&mut self.connection, migrations, &options).unwrap()
        }

        /// The files in the backups folder, sorted (none if it does not exist).
        fn backup_names(&self) -> Vec<String> {
            let Ok(entries) = std::fs::read_dir(self.folder.path().join("backups")) else {
                return Vec::new();
            };
            let mut names: Vec<String> = entries
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .collect();
            names.sort();
            names
        }

        /// Starts `days` times in a row with a migration that always fails.
        fn fail_to_migrate(&mut self, version: &str, days: std::ops::RangeInclusive<i64>) {
            for day in days {
                let options = self.options(version, day);
                let result = upgrade(&mut self.connection, &[FOUNDATION, BROKEN], &options);
                assert!(matches!(result, Err(StoreError::MigrationFailed { .. })));
            }
        }
    }

    #[test]
    fn never_backs_up_a_new_database() {
        let mut setup = Setup::new();

        let report = setup.run(&[FOUNDATION], "0.1.0", 0);

        assert_eq!(report.backup, None);
        assert_eq!(setup.backup_names().len(), 0);
    }

    #[test]
    fn backs_up_the_previous_schema_before_migrating() {
        let mut setup = Setup::new();
        setup.run(&[FOUNDATION], "0.1.0", 0);

        let report = setup.run(&[FOUNDATION, EXTRA], "0.1.0", 1);

        let backup = Connection::open(report.backup.unwrap()).unwrap();
        let versions: i64 = backup
            .query_row("SELECT max(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(versions, 1);
    }

    #[test]
    fn backs_up_when_only_the_binary_version_changed() {
        let mut setup = Setup::new();
        setup.run(&[FOUNDATION], "0.1.0", 0);

        let report = setup.run(&[FOUNDATION], "0.2.0", 1);

        assert!(report.backup.is_some());
        assert_eq!(report.applied, Vec::<&str>::new());
    }

    #[test]
    fn does_not_back_up_when_nothing_changed() {
        let mut setup = Setup::new();
        setup.run(&[FOUNDATION], "0.1.0", 0);

        let report = setup.run(&[FOUNDATION], "0.1.0", 1);

        assert_eq!(report.backup, None);
    }

    #[test]
    fn keeps_only_the_three_most_recent_backups() {
        let mut setup = Setup::new();
        setup.run(&[FOUNDATION], "0.1.0", 0);

        for (day, version) in ["0.2.0", "0.3.0", "0.4.0", "0.5.0"].into_iter().enumerate() {
            setup.run(&[FOUNDATION], version, i64::try_from(day).unwrap() + 1);
        }

        assert_eq!(setup.backup_names().len(), 3);
    }

    #[test]
    fn backs_up_once_when_the_same_migration_keeps_failing() {
        let mut setup = Setup::new();
        setup.run(&[FOUNDATION], "0.1.0", 0);

        setup.fail_to_migrate("0.2.0", 1..=10);

        assert_eq!(setup.backup_names().len(), 1);
    }

    #[test]
    fn keeps_the_older_backups_when_the_same_migration_keeps_failing() {
        let mut setup = Setup::new();
        setup.run(&[FOUNDATION], "0.1.0", 0);
        setup.run(&[FOUNDATION], "0.1.1", 1);
        setup.run(&[FOUNDATION], "0.1.2", 2);

        setup.fail_to_migrate("0.2.0", 3..=12);

        let names = setup.backup_names();
        assert_eq!(names.len(), 3, "{names:?}");
        assert!(
            names.iter().any(|name| name.contains("-v0.1.2-")),
            "{names:?}"
        );
        assert!(
            names.iter().any(|name| name.contains("-v0.2.0-")),
            "{names:?}"
        );
    }

    #[test]
    fn never_keeps_more_backups_than_asked_while_a_migration_fails() {
        let mut setup = Setup::new();
        setup.run(&[FOUNDATION], "0.1.0", 0);

        for day in 1..=10 {
            // Each failed start finds the database changed, so each one backs it up.
            setup
                .connection
                .execute_batch(&format!("CREATE TABLE changed_{day} (id INTEGER) STRICT"))
                .unwrap();
            setup.fail_to_migrate("0.2.0", day..=day);
        }

        assert_eq!(setup.backup_names().len(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn migrates_nothing_when_the_backup_cannot_be_written() {
        use std::os::unix::fs::PermissionsExt;

        let mut setup = Setup::new();
        setup.run(&[FOUNDATION], "0.1.0", 0);
        let backups = setup.folder.path().join("backups");
        std::fs::create_dir(&backups).unwrap();
        std::fs::set_permissions(&backups, std::fs::Permissions::from_mode(0o500)).unwrap();

        let options = setup.options("0.1.0", 1);
        let result = upgrade(&mut setup.connection, &[FOUNDATION, EXTRA], &options);

        std::fs::set_permissions(&backups, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(result, Err(StoreError::Backup { .. })));
        let applied = read_applied(&setup.connection).unwrap();
        assert_eq!(applied.len(), 1);
    }
}
