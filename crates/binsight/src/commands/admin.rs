//! `binsight admin`: inspecting and maintaining an installation.
//!
//! - `config` shows the effective configuration, secrets hidden, with where each value came from;
//! - `backup` writes a backup now; it only reads the database, so it works while `run` runs;
//! - `db-status` shows the schema version, the pending migrations and the projections;
//! - `rotate-sessions` signs everyone out; it writes, so it takes the data folder lock and
//!   refuses while `run` runs.

mod effective_config;

use std::path::Path;

use binsight_core::clock::Clock;
use binsight_engine::SystemClock;
use binsight_store::{BackupOptions, ProjectionStatus, Store};

use super::{VERSION, block_on};
use crate::cli::AdminCommand;
use crate::config::{self, Config};
use crate::data_dir::{LockedDataDir, backups_path, database_path};
use crate::failure::Failure;
use crate::instance_secrets::rotate_session_secret;
use crate::output::print_line;
use effective_config::describe;

/// Runs one maintenance task.
pub(super) fn execute(config_file: Option<&Path>, command: &AdminCommand) -> Result<(), Failure> {
    let config = config::load(config_file)?.config;
    match command {
        AdminCommand::Config => {
            show_config(&config);
            Ok(())
        }
        AdminCommand::Backup => block_on(back_up(&config)),
        AdminCommand::DbStatus => block_on(show_database_status(&config)),
        AdminCommand::RotateSessions => block_on(rotate_sessions(&config)),
    }
}

fn show_config(config: &Config) {
    for line in describe(config) {
        print_line(&line);
    }
}

async fn back_up(config: &Config) -> Result<(), Failure> {
    let store = Store::open_existing(&database_path(&config.data_dir)).await?;
    let backups = BackupOptions {
        folder: backups_path(&config.data_dir),
        keep: BackupOptions::DEFAULT_KEEP,
    };
    let path = store.back_up(&backups, VERSION, SystemClock.now()).await?;
    print_line(&format!("Backup written to {}", path.display()));
    Ok(())
}

/// Opens a database this binary may write to: one at exactly its schema version. A newer one is
/// refused like `run` refuses it (exit 65), an older one until `run` has upgraded it.
async fn open_up_to_date(path: &Path) -> Result<Store, Failure> {
    let store = Store::open_existing(path).await?;
    let schema = store.schema_status().await?;
    if !schema.pending.is_empty() {
        return Err(Failure::Usage(
            "the database is older than this binsight; start `binsight run` once to upgrade it, \
             then try again"
                .to_owned(),
        ));
    }
    Ok(store)
}

async fn show_database_status(config: &Config) -> Result<(), Failure> {
    let store = Store::open_existing(&database_path(&config.data_dir)).await?;
    let schema = store.schema_status().await?;
    print_line(&format!(
        "Schema version: {} (this binsight knows up to {})",
        schema.current_version, schema.latest_version
    ));
    if schema.pending.is_empty() {
        print_line("Pending migrations: none");
    } else {
        print_line(&format!(
            "Pending migrations: {}",
            schema.pending.join(", ")
        ));
    }
    let projections = store.projections().list().await?;
    if projections.is_empty() {
        print_line("Projections: none");
    }
    for projection in projections {
        let state = match projection.status {
            ProjectionStatus::Building => "being rebuilt".to_owned(),
            ProjectionStatus::Ready { built_at } => format!("ready since {built_at}"),
        };
        print_line(&format!(
            "Projection {} (calc version {}): {state}",
            projection.name, projection.calc_version
        ));
    }
    Ok(())
}

async fn rotate_sessions(config: &Config) -> Result<(), Failure> {
    let data_dir = LockedDataDir::open(&config.data_dir)?;
    let store = open_up_to_date(&data_dir.database_path()).await?;
    rotate_session_secret(&store).await?;
    print_line("Every session is signed out; sign in again with the password.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refuses_to_write_to_a_database_that_was_never_upgraded() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.db");
        std::fs::File::create(&path).unwrap();

        let refusal = open_up_to_date(&path).await.unwrap_err();

        assert!(matches!(refusal, Failure::Usage(_)), "{refusal}");
    }
}
