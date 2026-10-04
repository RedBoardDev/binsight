//! The command line: the commands and their options, declared with clap.
//!
//! This module only declares; `commands` runs them. Configuration values are not command-line
//! options: they come from the environment or the configuration file, so there is one way to set
//! each of them.

use std::path::PathBuf;

use binsight_solana::{Address, Signature};
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
    /// Write a configuration file with your Helius API key and password (asked without echo)
    Init {
        /// Replace the configuration file if it already exists
        #[arg(long)]
        force: bool,
    },
    /// Run the server: open and upgrade the database, start the engine, serve the API and the
    /// web app until stopped (Ctrl-C or SIGTERM)
    Run,
    /// Inspect and maintain an installation
    Admin {
        /// The maintenance task.
        #[command(subcommand)]
        command: AdminCommand,
    },
    /// Check that the local server answers (for container health checks)
    #[command(hide = true)]
    Healthcheck,
}

/// The maintenance tasks.
#[derive(Debug, Subcommand)]
pub enum AdminCommand {
    /// Show the effective configuration and where each value comes from (secrets are hidden)
    Config,
    /// Back up the database now (works while the server runs)
    Backup,
    /// Show the database schema version, pending migrations and projections
    DbStatus,
    /// Sign out every session by replacing the session secret (the server must be stopped)
    RotateSessions,
    /// Track a wallet; its history is imported when the server starts (the server must be stopped)
    WalletAdd {
        /// The wallet's address (base58)
        address: Address,
    },
    /// Show how far each wallet is imported and the credits spent (works while the server runs)
    SyncStatus,
    /// Print a stored transaction exactly as the RPC node returned it (works while the server runs)
    ExportTx {
        /// The transaction signature (base58)
        signature: Signature,
    },
}
