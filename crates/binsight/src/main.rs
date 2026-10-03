//! # binsight
//!
//! **Responsibility:** the composition root and the command line. It reads the configuration, wires
//! the store, the chain client, the engine and the API together, embeds the web app and offers the
//! `init`, `run` and `admin` commands.
//!
//! **May depend on:** every binsight crate.
//! **Must not be depended on:** it is the top of the dependency graph.
//! (Checked in CI by `cargo xtask layering`.)

use std::process::ExitCode;

fn main() -> ExitCode {
    ExitCode::SUCCESS
}
