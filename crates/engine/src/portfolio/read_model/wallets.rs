//! Reads about the tracked wallets.

use binsight_ledger::report::valued::Currency;

use crate::portfolio::answer::Answer;
use crate::portfolio::views::WalletsView;

/// What the API reads about the tracked wallets.
pub trait WalletReads: Send + Sync {
    /// The tracked wallets with their figures in `currency`.
    fn wallets(&self, currency: Currency) -> Answer<'_, WalletsView>;
}
