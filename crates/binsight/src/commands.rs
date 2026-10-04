//! Runs the command chosen on the command line.
//!
//! Each command lives in its own module and returns a [`Failure`] when it fails; the binary turns
//! that into the exit code. This module only dispatches.

mod admin;
mod healthcheck;
mod init;
mod run;

use crate::cli::{Cli, Command};
use crate::failure::Failure;

/// The version of this binary.
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Runs the command of `cli`.
///
/// # Errors
///
/// Returns the failure of the command.
pub fn execute(cli: &Cli) -> Result<(), Failure> {
    match &cli.command {
        Command::Init { force } => init::execute(cli.config_file.as_deref(), *force),
        Command::Run => run::execute(cli.config_file.as_deref()),
        Command::Admin { command } => admin::execute(cli.config_file.as_deref(), command),
        Command::Healthcheck => healthcheck::execute(cli.config_file.as_deref()),
    }
}

/// Runs `task` to completion on a small runtime, for the short-lived commands.
fn block_on<T>(task: impl Future<Output = Result<T, Failure>>) -> Result<T, Failure> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| Failure::io("start the async runtime", error))?;
    runtime.block_on(task)
}
