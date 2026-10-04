//! Lists the repository's source files and counts their lines.
//!
//! Files come from git, so build outputs and ignored files are never measured; files not yet
//! committed are included so the check also works before a commit. This module only gathers
//! data; it does not apply any limit.

use std::io::ErrorKind;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, bail};

use super::limits;

/// A file of the repository and its number of lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TrackedFile {
    /// The path relative to the repository root, with `/` separators.
    pub(crate) path: String,
    /// The number of lines in the file.
    pub(crate) lines: usize,
}

/// Every file git knows about (committed or new, minus ignored ones) that the limits apply to.
pub(crate) fn list_source_files(root: &Path) -> anyhow::Result<Vec<TrackedFile>> {
    let mut files = Vec::new();
    for path in git_files(root)? {
        if limits::classify(&path).is_none() {
            continue;
        }
        let content = match std::fs::read_to_string(root.join(&path)) {
            Ok(content) => content,
            // Deleted in the working tree but not yet from git: nothing to measure.
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error).with_context(|| format!("could not read {path}")),
        };
        files.push(TrackedFile {
            path,
            lines: content.lines().count(),
        });
    }
    Ok(files)
}

/// Runs `git ls-files` for committed and new files, excluding everything git ignores.
fn git_files(root: &Path) -> anyhow::Result<Vec<String>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .context("could not run `git ls-files`")?;
    if !output.status.success() {
        bail!(
            "`git ls-files` failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let listing = String::from_utf8(output.stdout).context("git listed a non UTF-8 path")?;
    let mut paths: Vec<String> = listing
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}
