//! The registry's own invariants, inspected and restored without any network call.
//!
//! The store keeps several facts in step: a wallet's listed signatures and their counter, its
//! cursor and the rows the cursor points at, each listed signature and its fetch task, a task
//! marked fetched and its raw transaction, each raw transaction and its decoding result. Every
//! write keeps them together in one transaction, so they can only disagree after a bug, a manual
//! edit or a database copied from elsewhere. This module reads how far they disagree
//! ([`RegistryInspection`], `inspection`) and offers the fixes that need nothing but the database
//! (`restoring`). Which fix to apply, and what else a disagreement calls for, is the engine's
//! decision.

mod inspection;
mod restoring;

pub use inspection::{CurrentDecoder, RegistryInspection, WalletInspection};

use crate::database::Database;
use crate::store::Store;

/// Inspects and restores the registry's invariants. Get one with [`Store::consistency`].
#[derive(Debug, Clone)]
pub struct ConsistencyRepo {
    database: Database,
}

impl Store {
    /// The registry's invariants.
    pub fn consistency(&self) -> ConsistencyRepo {
        ConsistencyRepo {
            database: self.database().clone(),
        }
    }
}

#[cfg(test)]
mod tests;
