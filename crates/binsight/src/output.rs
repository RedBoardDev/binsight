//! The only place that writes to standard output and standard error directly.
//!
//! Command results go to standard output; failures go to standard error with their causes, one
//! per line, so the owner sees why and not only what. Logs do not come through here (they go
//! through `tracing`). A failed write (a closed pipe) is ignored: there is nowhere left to report
//! it.

use std::error::Error;
use std::io::Write;

use crate::failure::Failure;

/// Writes `text` and a newline to standard output.
pub fn print_line(text: &str) {
    let _ = writeln!(std::io::stdout().lock(), "{text}");
}

/// Writes a failure and each of its causes to standard error.
pub fn print_failure(failure: &Failure) {
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "error: {failure}");
    let mut cause = failure.source();
    while let Some(error) = cause {
        let _ = writeln!(stderr, "  caused by: {error}");
        cause = error.source();
    }
}
