//! The handle the rest of the application uses to talk to the engine.
//!
//! A handle is cheap to clone and safe to share between tasks. It reads the current status,
//! checks the health, subscribes to the engine's events and reads the portfolio from the source
//! of figures it was given; it cannot stop or drive the engine, which only the owner of
//! [`crate::Engine`] can do.

use std::sync::Arc;

use binsight_store::Store;
use tokio::sync::{broadcast, watch};

use crate::events::EngineEvent;
use crate::health::{EngineHealth, check_database};
use crate::portfolio::{DataSource, DataSourceKind, NotReadyPortfolio, ReadModel};
use crate::status::EngineStatus;

/// A shared, read-only view of a running engine.
#[derive(Clone)]
pub struct EngineHandle {
    store: Store,
    status: watch::Receiver<EngineStatus>,
    events: broadcast::Sender<EngineEvent>,
    data_source: DataSourceKind,
    read_model: Arc<dyn ReadModel>,
}

impl std::fmt::Debug for EngineHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EngineHandle")
            .field("store", &self.store)
            .field("data_source", &self.data_source)
            .finish_non_exhaustive()
    }
}

impl EngineHandle {
    pub(crate) fn new(
        store: Store,
        status: watch::Receiver<EngineStatus>,
        events: broadcast::Sender<EngineEvent>,
    ) -> Self {
        Self {
            store,
            status,
            events,
            data_source: DataSourceKind::Chain,
            read_model: Arc::new(NotReadyPortfolio),
        }
    }

    /// The same handle, reading the portfolio from `source`. In chain mode the portfolio is not
    /// ready until the engine serves figures.
    #[must_use]
    pub fn with_data_source(mut self, source: DataSource) -> Self {
        self.data_source = source.kind();
        self.read_model = match source {
            DataSource::Chain => Arc::new(NotReadyPortfolio),
            DataSource::Demo(read_model) => read_model,
        };
        self
    }

    /// Which source serves the figures.
    pub fn data_source(&self) -> DataSourceKind {
        self.data_source
    }

    /// The portfolio, as the API reads it.
    pub fn read_model(&self) -> &dyn ReadModel {
        self.read_model.as_ref()
    }

    /// The database, for the engine's own tests.
    #[cfg(test)]
    pub(crate) fn store(&self) -> &Store {
        &self.store
    }

    /// The current lifecycle status.
    pub fn status(&self) -> EngineStatus {
        *self.status.borrow()
    }

    /// Checks that the database answers (with a short deadline) and reports the status.
    pub async fn health(&self) -> EngineHealth {
        EngineHealth {
            database: check_database(&self.store).await,
            engine: self.status(),
        }
    }

    /// Starts receiving the events published from now on.
    ///
    /// A receiver that falls too far behind loses the oldest events and is told how many it
    /// missed; it should then refresh its state rather than rely on the stream.
    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.events.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use binsight_ledger::report::valued::Currency;

    use crate::portfolio::{DataSource, DataSourceKind, ReadError};
    use crate::test_support::temporary_engine;

    #[tokio::test]
    async fn answers_not_ready_in_chain_mode() {
        let setup = temporary_engine().await;
        let handle = setup.handle.with_data_source(DataSource::Chain);

        assert_eq!(handle.data_source(), DataSourceKind::Chain);
        let wallets = handle.read_model().wallets(Currency::Sol).await;
        assert_eq!(wallets, Err(ReadError::NotReady));
        let sync = handle.read_model().sync_report().await;
        assert_eq!(sync, Err(ReadError::NotReady));
    }
}
