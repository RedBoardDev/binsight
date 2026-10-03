//! A real engine on a throw-away database, for the tests of the crates above the engine.
//!
//! Compiled only for tests and with the `test-support` feature, which only dev-dependencies
//! enable. It lets the
//! API test against a real engine and a real SQLite file without depending on the store itself.

use binsight_store::{BackupOptions, Store, UpgradeOptions};
use jiff::Timestamp;

use crate::engine::Engine;
use crate::handle::EngineHandle;

/// An engine on a database in a temporary folder, deleted when this value is dropped.
#[derive(Debug)]
pub struct TemporaryEngine {
    /// The folder holding the database; keep it alive as long as the engine is used.
    pub folder: tempfile::TempDir,
    /// The engine, not yet running.
    pub engine: Engine,
    /// Its handle.
    pub handle: EngineHandle,
}

/// Creates a migrated database in a new temporary folder and builds an engine on it.
///
/// # Panics
///
/// Panics if the folder or the database cannot be created: a test that cannot set up must fail
/// loudly.
#[expect(
    clippy::expect_used,
    reason = "test support: a failed setup must stop the test immediately"
)]
pub async fn temporary_engine() -> TemporaryEngine {
    let folder = tempfile::tempdir().expect("could not create a temporary folder");
    let options = UpgradeOptions {
        binary_version: "0.0.0-test".to_owned(),
        now: Timestamp::UNIX_EPOCH,
        backups: BackupOptions {
            folder: folder.path().join("backups"),
            keep: 1,
        },
    };
    let (store, _report) = Store::open_and_upgrade(&folder.path().join("binsight.db"), options)
        .await
        .expect("could not create the temporary database");
    let (engine, handle) = Engine::new(store);
    TemporaryEngine {
        folder,
        engine,
        handle,
    }
}
