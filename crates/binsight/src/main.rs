//! The `binsight` executable. All the work is done by the `binsight` library; this file only
//! parses the command line, runs the command and turns its outcome into the process exit code.

use std::process::ExitCode;

use binsight::cli::Cli;
use binsight::{commands, output};
use clap::Parser;

fn main() -> ExitCode {
    let cli = Cli::parse();
    match commands::execute(&cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            output::print_failure(&failure);
            failure.exit_code()
        }
    }
}
