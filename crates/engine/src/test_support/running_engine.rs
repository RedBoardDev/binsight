//! An engine running in the background of a test, and a way to wait for its progress.
//!
//! Tests run on paused time: waiting a second lets every worker take its next step, so a test
//! waits for a state of the database instead of guessing how long the engine needs.

use std::sync::Arc;
use std::time::Duration;

use binsight_chain::test_support::{ScriptedConnector, ScriptedTransport};
use binsight_solana::Address;
use binsight_store::{FetchCounts, Store, WalletCursor};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::TemporaryEngine;
use crate::error::EngineError;

/// How long a test lets the engine work, on paused time, before giving up.
const PATIENCE: Duration = Duration::from_secs(3_600);

/// An engine running in the background.
#[derive(Debug)]
pub struct RunningEngine {
    /// The folder holding the database.
    pub folder: tempfile::TempDir,
    /// The database.
    pub store: Store,
    /// The scripted provider.
    pub transport: Arc<ScriptedTransport>,
    /// The scripted stream.
    pub stream: Arc<ScriptedConnector>,
    shutdown: CancellationToken,
    task: JoinHandle<Result<(), EngineError>>,
}

impl RunningEngine {
    /// Starts running `setup`'s engine.
    pub fn start(setup: TemporaryEngine) -> Self {
        let shutdown = CancellationToken::new();
        let task = tokio::spawn(setup.engine.run(shutdown.clone()));
        Self {
            folder: setup.folder,
            store: setup.store,
            transport: setup.transport,
            stream: setup.stream,
            shutdown,
            task,
        }
    }

    /// Waits until `wallet`'s fetch counts satisfy `done`, and returns them.
    ///
    /// # Panics
    ///
    /// Panics if they still do not after an hour of (paused) time, or the database fails.
    #[expect(
        clippy::expect_used,
        reason = "test support: a stuck engine must fail the test"
    )]
    pub async fn wait_for_counts(
        &self,
        wallet: Address,
        done: impl Fn(&FetchCounts) -> bool,
    ) -> FetchCounts {
        let started = tokio::time::Instant::now();
        loop {
            let counts = self
                .store
                .fetch_queue()
                .counts(wallet)
                .await
                .expect("could not count the fetch tasks");
            if done(&counts) {
                return counts;
            }
            assert!(
                started.elapsed() <= PATIENCE,
                "the engine never reached the expected state: {counts:?}"
            );
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    /// Waits until `wallet`'s history is completely listed, and returns its cursor.
    ///
    /// # Panics
    ///
    /// Panics if it still is not after an hour of (paused) time, or the database fails.
    #[expect(
        clippy::expect_used,
        reason = "test support: a stuck engine must fail the test"
    )]
    pub async fn wait_for_complete_history(&self, wallet: Address) -> WalletCursor {
        let started = tokio::time::Instant::now();
        loop {
            let wallets = self
                .store
                .wallets()
                .list()
                .await
                .expect("could not read the tracked wallets");
            let cursor = wallets
                .iter()
                .find(|tracked| tracked.address == wallet)
                .map(|tracked| tracked.cursor);
            if let Some(cursor @ WalletCursor::HistoryComplete { .. }) = cursor {
                return cursor;
            }
            assert!(
                started.elapsed() <= PATIENCE,
                "the history was never completely listed: {cursor:?}"
            );
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    /// Waits until the scripted provider received `count` requests.
    ///
    /// # Panics
    ///
    /// Panics if it still has not after an hour of (paused) time.
    pub async fn wait_for_calls(&self, count: usize) {
        let started = tokio::time::Instant::now();
        while self.transport.calls().len() < count {
            assert!(
                started.elapsed() <= PATIENCE,
                "the engine never sent {count} requests: {:?}",
                self.transport.calls()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Asks the engine to stop, waits until it has, checks that it sent no request the test did
    /// not expect, and gives the database folder back.
    ///
    /// # Panics
    ///
    /// Panics if the engine failed, its task panicked, or it sent an unexpected request.
    #[expect(
        clippy::expect_used,
        reason = "test support: a failed engine must fail the test"
    )]
    pub async fn stop(self) -> tempfile::TempDir {
        self.shutdown.cancel();
        self.task
            .await
            .expect("the engine task panicked")
            .expect("the engine failed");
        self.transport.assert_no_unexpected_calls();
        self.folder
    }
}
