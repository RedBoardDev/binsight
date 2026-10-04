//! A real engine on a throw-away database, for the tests of the engine and of the crates above
//! it.
//!
//! Compiled only for tests and with the `test-support` feature, which only dev-dependencies
//! enable. The engine reaches the chain through a scripted transport and a scripted stream (one
//! that confirms every subscription), so no test touches the network, and reads the time from a
//! clock that follows tokio's, so tests on paused time move both together.

mod chain_replies;
mod running_engine;
mod tokio_clock;

pub use chain_replies::{
    complete_history, expect_nothing_new, expect_transactions, numbered_signature, signature_page,
    transaction_reply,
};
pub use running_engine::RunningEngine;
pub use tokio_clock::TokioClock;

use std::sync::Arc;

use binsight_chain::RpcClient;
use binsight_chain::test_support::{ScriptedConnector, ScriptedTransport, scripted_client};
use binsight_core::clock::{Clock, utc_day};
use binsight_core::credits::{CallOutcome, Credits, Priority, Purpose};
use binsight_store::{BackupOptions, CreditUsage, Store, UpgradeOptions};
use jiff::Timestamp;

use crate::engine::Engine;
use crate::handle::EngineHandle;

/// The instant the test clock starts at: 2026-09-21 at 14:13:20 UTC.
pub const TEST_START: Timestamp = Timestamp::constant(1_790_000_000, 0);

/// An engine on a database in a temporary folder, deleted when this value is dropped.
#[derive(Debug)]
pub struct TemporaryEngine {
    /// The folder holding the database; keep it alive as long as the engine is used.
    pub folder: tempfile::TempDir,
    /// The engine, not yet running.
    pub engine: Engine,
    /// Its handle.
    pub handle: EngineHandle,
    /// Its database.
    pub store: Store,
    /// The scripted provider it sends its RPC requests to.
    pub transport: Arc<ScriptedTransport>,
    /// The scripted stream it watches wallets through.
    pub stream: Arc<ScriptedConnector>,
}

/// Creates a migrated database in a new temporary folder and builds an engine on it, with a
/// scripted provider, the [`TokioClock`] and no daily credit limit.
pub async fn temporary_engine() -> TemporaryEngine {
    temporary_engine_with_limit(None).await
}

/// Like [`temporary_engine`], with a hard daily credit limit.
///
/// # Panics
///
/// Panics if the folder or the database cannot be created: a test that cannot set up must fail
/// loudly.
#[expect(
    clippy::expect_used,
    reason = "test support: a failed setup must stop the test immediately"
)]
pub async fn temporary_engine_with_limit(daily_credit_limit: Option<Credits>) -> TemporaryEngine {
    let folder = tempfile::tempdir().expect("could not create a temporary folder");
    engine_in(folder, daily_credit_limit).await
}

/// Builds a new engine, with a new scripted provider, on the database `folder` already holds, as
/// a restart would.
pub async fn reopened_engine(folder: tempfile::TempDir) -> TemporaryEngine {
    engine_in(folder, None).await
}

async fn engine_in(
    folder: tempfile::TempDir,
    daily_credit_limit: Option<Credits>,
) -> TemporaryEngine {
    let store = migrated_store(&folder).await;
    let transport = ScriptedTransport::new();
    let stream = ScriptedConnector::new();
    let clock: Arc<dyn Clock> = Arc::new(TokioClock::starting_at(TEST_START));
    let rpc: RpcClient = scripted_client(transport.clone(), clock.clone(), daily_credit_limit);
    let (engine, handle) = Engine::new(store.clone(), rpc, stream.clone(), clock);
    TemporaryEngine {
        folder,
        engine,
        handle,
        store,
        transport,
        stream,
    }
}

/// Records `credits` as spent on [`TEST_START`]'s day, as an earlier run would have, so the
/// engine's budget starts from there.
///
/// # Panics
///
/// Panics if the database cannot be written.
#[expect(
    clippy::expect_used,
    reason = "test support: a failed setup must stop the test immediately"
)]
pub async fn record_spent_today(store: &Store, credits: Credits) {
    let usage = CreditUsage {
        day: utc_day(TEST_START),
        method: "getTransaction".to_owned(),
        priority: Priority::History,
        purpose: Purpose::TransactionFetch,
        wallet: None,
        outcome: CallOutcome::Ok,
        calls: credits.0,
        credits,
    };
    store
        .credits()
        .add(vec![usage])
        .await
        .expect("could not record the credits spent");
}

#[expect(
    clippy::expect_used,
    reason = "test support: a failed setup must stop the test immediately"
)]
async fn migrated_store(folder: &tempfile::TempDir) -> Store {
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
    store
}
