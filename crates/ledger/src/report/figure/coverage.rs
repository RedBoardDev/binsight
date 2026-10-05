//! The history coverage needed by a period aggregate or a positions family.

use jiff::Timestamp;

use super::{Reason, Reasons};
use crate::facts::{HistoryCoverage, WalletFacts};

/// Why the wallets do not cover `start`; `None` requires their whole history.
pub fn history_reasons<'a>(
    wallets: impl IntoIterator<Item = &'a WalletFacts>,
    start: Option<Timestamp>,
) -> Reasons {
    wallets
        .into_iter()
        .filter_map(|wallet| match wallet.history {
            HistoryCoverage::Importing { progress, .. }
                if start.is_none_or(|start| !wallet.history.covers(start)) =>
            {
                Some(Reason::HistoryIncomplete {
                    wallet: wallet.address,
                    progress,
                })
            }
            _ => None,
        })
        .collect()
}
