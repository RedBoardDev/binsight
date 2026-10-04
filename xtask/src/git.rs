//! The questions the tasks ask git about the repository they run in.
//!
//! This module only runs `git rev-parse` and returns paths; it never changes the repository.

use std::path::PathBuf;
use std::process::Command;

use anyhow::{Context, bail};

/// The root of the working tree the command runs in.
pub(crate) fn repository_root() -> anyhow::Result<PathBuf> {
    rev_parse(&["--show-toplevel"], "the repository root")
}

/// The git directory shared by every worktree of the repository (where `info/` lives).
pub(crate) fn common_directory() -> anyhow::Result<PathBuf> {
    rev_parse(
        &["--path-format=absolute", "--git-common-dir"],
        "the git common directory",
    )
}

/// Runs `git rev-parse` with `arguments` and returns the path it prints.
fn rev_parse(arguments: &[&str], what: &str) -> anyhow::Result<PathBuf> {
    let output = Command::new("git")
        .arg("rev-parse")
        .args(arguments)
        .output()
        .context("could not run `git rev-parse`")?;
    if !output.status.success() {
        bail!(
            "could not find {what}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let path = String::from_utf8(output.stdout).context("git printed a non UTF-8 path")?;
    Ok(PathBuf::from(path.trim_end()))
}
