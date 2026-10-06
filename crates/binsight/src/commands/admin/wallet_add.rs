//! `binsight admin wallet-add`: start tracking a wallet.
//!
//! The wallet is written with nothing listed yet; the engine imports its history the next time
//! the server starts. Adding writes to the database, so it takes the data folder lock and refuses
//! while the server runs. Like `run`, it creates the database or upgrades it (after a backup), so
//! a wallet can be added before the first start. Demo mode tracks nothing, so it refuses: a
//! wallet in the demo folder would make the next demo start refuse that folder.

use binsight_core::clock::Clock;
use binsight_engine::SystemClock;
use binsight_solana::Address;

use crate::commands::run::open_store;
use crate::config::{Config, DataSourceConfig};
use crate::data_dir::LockedDataDir;
use crate::failure::Failure;
use crate::output::print_line;

/// Tracks `address`, unless it already is.
pub(super) async fn add_wallet(config: &Config, address: Address) -> Result<(), Failure> {
    if matches!(config.data_source, DataSourceConfig::Demo) {
        return Err(Failure::WalletInDemo);
    }
    let data_dir = LockedDataDir::open(&config.data_dir)?;
    let store = open_store(&data_dir, &SystemClock).await?;
    let added = store.wallets().add(address, SystemClock.now()).await?;
    if added {
        print_line(&format!(
            "Tracking {address}; its history is imported when `binsight run` starts."
        ));
    } else {
        print_line(&format!("{address} is already tracked."));
    }
    Ok(())
}
