//! `binsight admin repair <ADDRESS>`: a full repair of a wallet's listing, planned and, when
//! asked, scheduled.
//!
//! A full repair lists the wallet's signatures again, from the newest down to its first
//! transaction, and fills what the registry lacks. By default the command is a dry run: it only
//! prints what the repair would send and its cost in credits, reading the database, so it works
//! while the server runs. With `--apply` it asks for the repair: that writes, so it takes the data
//! folder lock and refuses while the server runs; the repair runs when the server starts, at the
//! history priority, through the credit budget.

use binsight_engine::{RepairEstimate, estimate_full_repair};
use binsight_solana::Address;
use binsight_store::Store;

use super::open_up_to_date;
use crate::config::Config;
use crate::data_dir::{LockedDataDir, database_path};
use crate::failure::Failure;
use crate::output::print_line;

/// Prints what a full repair of `address` would send and cost, changing nothing.
pub(super) async fn plan_repair(config: &Config, address: Address) -> Result<(), Failure> {
    let store = Store::open_existing(&database_path(&config.data_dir)).await?;
    let listed = listed_signatures(&store, address).await?;
    for line in describe_plan(address, listed, &estimate_full_repair(listed)) {
        print_line(&line);
    }
    print_line(
        "Dry run: nothing was changed. Add --apply to ask for it (with the server stopped).",
    );
    Ok(())
}

/// Asks a full repair of `address`, which runs when the server starts.
pub(super) async fn ask_repair(config: &Config, address: Address) -> Result<(), Failure> {
    let data_dir = LockedDataDir::open(&config.data_dir)?;
    let store = open_up_to_date(&data_dir.database_path()).await?;
    let listed = listed_signatures(&store, address).await?;
    for line in describe_plan(address, listed, &estimate_full_repair(listed)) {
        print_line(&line);
    }
    store.repairs().ask_full(address).await?;
    print_line("Asked: the repair runs when `binsight run` starts, at the history priority.");
    Ok(())
}

/// How many signatures `address` lists; refuses a wallet that is not tracked.
async fn listed_signatures(store: &Store, address: Address) -> Result<u64, Failure> {
    let wallets = store.wallets().progress().await?;
    wallets
        .iter()
        .find(|progress| progress.wallet.address == address)
        .map(|progress| progress.listing.listed)
        .ok_or_else(|| {
            Failure::Usage(format!(
                "{address} is not tracked; add it with `binsight admin wallet-add {address}`"
            ))
        })
}

/// The lines describing the plan of a full repair of `address`, which lists `listed`
/// signatures.
fn describe_plan(address: Address, listed: u64, plan: &RepairEstimate) -> Vec<String> {
    vec![
        format!(
            "A full repair of {address} lists its {listed} signatures again, newest first, down \
             to its first transaction, and fills what the registry lacks."
        ),
        format!(
            "Cost: {} getSignaturesForAddress requests, {} credits (more if the chain holds \
             signatures the wallet does not list yet), plus {} credit per missing transaction it \
             finds.",
            plan.listing_requests, plan.credits.0, plan.credits_per_gap.0
        ),
    ]
}

#[cfg(test)]
mod tests {
    use binsight_core::credits::Credits;

    use super::*;

    #[test]
    fn describes_the_plan_and_its_credits() {
        let plan = RepairEstimate {
            listing_requests: 3,
            credits: Credits(3),
            credits_per_gap: Credits(1),
        };

        let lines = describe_plan(Address::from_bytes([1; 32]), 2_500, &plan);

        assert!(lines[0].contains("lists its 2500 signatures again"));
        assert!(lines[1].starts_with("Cost: 3 getSignaturesForAddress requests, 3 credits"));
        assert!(lines[1].ends_with("plus 1 credit per missing transaction it finds."));
    }
}
