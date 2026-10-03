//! The command line: the commands and their options, declared with clap.
//!
//! This module only declares; `commands` runs them. Configuration values are not command-line
//! options: they come from the environment or the configuration file, so there is one way to set
//! each of them.

use std::path::PathBuf;

use clap::{Parser, Subcommand};

/// Self-hostable portfolio tracker for Meteora DLMM liquidity positions, with exact, on-chain
/// verified PnL.
#[derive(Debug, Parser)]
#[command(name = "binsight", version, propagate_version = true)]
pub struct Cli {
    /// The configuration file to read.
    #[arg(
        long,
        global = true,
        value_name = "PATH",
        help = "The configuration file to read [default: \
                $XDG_CONFIG_HOME/binsight/binsight.env or ~/.config/binsight/binsight.env]"
    )]
    pub config_file: Option<PathBuf>,

    /// What to do.
    #[command(subcommand)]
    pub command: Command,
}

/// The commands.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Run the server: open and upgrade the database, start the engine, serve the API and the
    /// web app until stopped (Ctrl-C or SIGTERM)
    Run,
}
