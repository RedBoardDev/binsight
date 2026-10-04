//! # xtask
//!
//! **Responsibility:** repository tooling, run with `cargo xtask <task>`:
//! - `layering` checks that every workspace crate only depends on what `rules.rs` allows;
//! - `structure` checks that source files and folders stay within the size limits.
//!
//! **May depend on:** no binsight crate; nobody depends on it.
//! (Checked in CI by `cargo xtask layering`.)

mod git;
mod layering;
mod metadata;
mod rules;
mod structure;

use std::process::ExitCode;

use crate::layering::Violation;
use crate::structure::Report;

/// The exit code for a command line that names no known task, as for other command-line tools.
const USAGE_ERROR_EXIT_CODE: u8 = 2;

fn main() -> ExitCode {
    let task = std::env::args().nth(1);
    match task.as_deref() {
        Some("layering") => run_layering(),
        Some("structure") => run_structure(),
        _ => {
            report_error("usage: cargo xtask <layering|structure>");
            ExitCode::from(USAGE_ERROR_EXIT_CODE)
        }
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

/// Checks the size of files and folders, printing warnings first and every error at once.
fn run_structure() -> ExitCode {
    let outcome = match structure::check_repository() {
        Ok(outcome) => outcome,
        Err(error) => {
            report_error(&format!("structure: {error:#}"));
            return ExitCode::FAILURE;
        }
    };
    print_structure_report(&outcome);
    if outcome.errors.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn print_structure_report(outcome: &Report) {
    for warning in &outcome.warnings {
        report_error(&format!("warning: {warning}"));
    }
    for error in &outcome.errors {
        report_error(&format!("error: {error}"));
    }
    if outcome.errors.is_empty() {
        report(&format!(
            "structure: {} source files checked; every file and folder is within the limits",
            outcome.checked_files
        ));
    } else {
        report_error(&format!(
            "structure: {} limit(s) broken; exceptions need a reason in \
             xtask/structure-allowlist.toml",
            outcome.errors.len()
        ));
    }
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
