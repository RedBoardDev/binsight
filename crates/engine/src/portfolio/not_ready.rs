//! The source of figures while the engine cannot serve any: every read answers "not ready".

use binsight_ledger::report::valued::Currency;

use super::answer::{Answer, answered};
use super::read_error::ReadError;
use super::read_model::{InstanceReads, WalletReads};
use super::views::{SyncReport, WalletsView};

/// A source that has no figures yet.
#[derive(Debug, Clone, Copy, Default)]
pub struct NotReadyPortfolio;

impl InstanceReads for NotReadyPortfolio {
    fn sync_report(&self) -> Answer<'_, SyncReport> {
        answered(Err(ReadError::NotReady))
    }
}

impl WalletReads for NotReadyPortfolio {
    fn wallets(&self, _currency: Currency) -> Answer<'_, WalletsView> {
        answered(Err(ReadError::NotReady))
    }
}
