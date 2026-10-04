//! `cargo xtask fixture`: capture real mainnet data for the tests.
//!
//! `capture` fetches transactions and accounts (for the domain tests) or one raw JSON-RPC answer
//! (for the chain client's tests) from Helius, refuses anything that cites a private address,
//! and writes the node's answers byte for byte. This module only dispatches the subcommand.

mod capture;
mod case_file;
mod command;
mod denylist;
mod helius;
mod identifiers;
mod staged_write;

use anyhow::bail;

/// Runs `cargo xtask fixture <arguments>` and returns a summary of what was written.
pub(crate) fn run(arguments: &[String]) -> anyhow::Result<String> {
    match arguments.split_first() {
        Some((subcommand, rest)) if subcommand == "capture" => {
            capture::capture(&command::parse(rest)?)
        }
        _ => bail!("{}", command::USAGE),
    }
}
