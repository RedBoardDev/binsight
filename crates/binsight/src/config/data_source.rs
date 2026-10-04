//! Where the figures come from: the chain (with a Helius key) or the generated demo world.

use binsight_chain::HeliusApiKey;

/// Where binsight takes its figures from.
///
/// A Helius key only exists in chain mode, so a configuration cannot be in demo mode and still
/// spend credits, nor in chain mode without a key.
#[derive(Debug, Clone)]
pub enum DataSourceConfig {
    /// Track the owner's wallets on the chain, through Helius.
    Chain {
        /// The Helius API key.
        helius_api_key: HeliusApiKey,
    },
    /// Serve a generated demo world; no wallet is tracked and no credit is spent.
    Demo,
}

/// Reads an on/off setting: `true` or `false`.
///
/// # Errors
///
/// Returns a message when the text is anything else.
pub(super) fn parse_switch(text: &str) -> Result<bool, &'static str> {
    match text {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err("expected true or false"),
    }
}
