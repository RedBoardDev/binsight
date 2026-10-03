//! # xtask
//!
//! **Responsibility:** repository tooling, run with `cargo xtask <task>`. Today it has one task:
//! `layering`, which checks that every workspace crate only depends on what `rules.rs` allows.
//!
//! **May depend on:** no binsight crate; nobody depends on it.
//! (Checked in CI by `cargo xtask layering`.)

mod layering;
mod metadata;
mod rules;

use std::process::ExitCode;

use crate::layering::Violation;

/// The exit code for a command line that names no known task, as for other command-line tools.
const USAGE_ERROR_EXIT_CODE: u8 = 2;

fn main() -> ExitCode {
    let task = std::env::args().nth(1);
    if task.as_deref() == Some("layering") {
        run_layering()
    } else {
        report_error("usage: cargo xtask layering");
        ExitCode::from(USAGE_ERROR_EXIT_CODE)
    }
}

/// Checks the workspace and reports every broken rule at once.
fn run_layering() -> ExitCode {
    match find_layering_violations() {
        Ok(violations) if violations.is_empty() => {
            report("layering: every crate respects its dependency rules");
            ExitCode::SUCCESS
        }
        Ok(violations) => {
            for violation in &violations {
                report_error(&violation.to_string());
            }
            report_error(&format!(
                "layering: {} rule(s) broken; the rules live in xtask/src/rules.rs",
                violations.len()
            ));
            ExitCode::FAILURE
        }
        Err(error) => {
            report_error(&format!("layering: {error:#}"));
            ExitCode::FAILURE
        }
    }
}

fn find_layering_violations() -> anyhow::Result<Vec<Violation>> {
    let json = metadata::run_cargo_metadata()?;
    let packages = metadata::parse_packages(&json)?;
    Ok(layering::check(&packages))
}

#[expect(
    clippy::print_stdout,
    reason = "xtask is a terminal tool; this is its only success output"
)]
fn report(line: &str) {
    println!("{line}");
}

#[expect(
    clippy::print_stderr,
    reason = "xtask is a terminal tool; this is its only error output"
)]
fn report_error(line: &str) {
    eprintln!("{line}");
}
