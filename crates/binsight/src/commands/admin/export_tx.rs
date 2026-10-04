//! `binsight admin export-tx`: print a stored transaction exactly as the RPC node returned it.
//!
//! The registry keeps the node's answer compressed; this command writes it back uncompressed, as
//! JSON, on standard output. It only reads, so it works while the server runs, and it costs no
//! credit: a decoder fixture can be taken from it.

use binsight_solana::Signature;
use binsight_store::Store;

use crate::config::Config;
use crate::data_dir::database_path;
use crate::failure::Failure;
use crate::output::print_line;

/// Prints the stored answer for `signature`.
pub(super) async fn export_tx(config: &Config, signature: Signature) -> Result<(), Failure> {
    let store = Store::open_existing(&database_path(&config.data_dir)).await?;
    let Some(payload) = store.raw_tx().payload(signature).await? else {
        return Err(Failure::Usage(format!(
            "the transaction {signature} is not in the registry"
        )));
    };
    let json = String::from_utf8(payload).map_err(|error| {
        Failure::Unexpected(anyhow::Error::new(error).context("the stored transaction is not text"))
    })?;
    print_line(&json);
    Ok(())
}
