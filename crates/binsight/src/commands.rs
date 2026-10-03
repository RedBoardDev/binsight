//! Runs the command chosen on the command line.
//!
//! Each command lives in its own module and returns a [`Failure`] when it fails; the binary turns
//! that into the exit code. This module only dispatches.

mod run;

use crate::cli::{Cli, Command};
use crate::failure::Failure;

/// Runs the command of `cli`.
///
/// # Errors
///
/// Returns the failure of the command.
pub fn execute(cli: &Cli) -> Result<(), Failure> {
    match cli.command {
        Command::Run => run::execute(cli.config_file.as_deref()),
    }
}
