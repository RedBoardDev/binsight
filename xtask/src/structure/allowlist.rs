//! Reads the explicit exceptions to the size limits from `xtask/structure-allowlist.toml`.
//!
//! An exception names one file (exempt from the line limit) or one folder (exempt from the file
//! count) and must say why. This module only reads and validates the list; deciding whether an
//! exception is still needed is the job of the structure check.

use anyhow::{Context, bail};
use serde::Deserialize;

/// The exceptions to the size limits, as written in the allowlist file.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Allowlist {
    /// Files allowed to exceed the line limit.
    pub(crate) files: Vec<Exception>,
    /// Folders allowed to exceed the source file count.
    pub(crate) folders: Vec<Exception>,
}

/// One exception: a path relative to the repository root, and why it is needed.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Exception {
    /// The file or folder, relative to the repository root, with `/` separators.
    pub(crate) path: String,
    /// Why the limit cannot be respected here. Mandatory and never empty.
    pub(crate) reason: String,
}

/// The layout of the TOML file: `[[file]]` and `[[folder]]` tables, both optional.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AllowlistFile {
    #[serde(default)]
    file: Vec<Exception>,
    #[serde(default)]
    folder: Vec<Exception>,
}

impl Allowlist {
    /// Whether `path` is an allowed exception to the line limit.
    pub(crate) fn allows_file(&self, path: &str) -> bool {
        self.files.iter().any(|exception| exception.path == path)
    }

    /// Whether `folder` is an allowed exception to the source file count.
    pub(crate) fn allows_folder(&self, folder: &str) -> bool {
        self.folders
            .iter()
            .any(|exception| exception.path == folder)
    }
}

/// Parses and validates the allowlist file content.
pub(crate) fn parse(text: &str) -> anyhow::Result<Allowlist> {
    let file: AllowlistFile = toml::from_str(text).context("the allowlist is not valid")?;
    let mut allowlist = Allowlist {
        files: file.file,
        folders: file.folder,
    };
    for exception in &mut allowlist.folders {
        exception.path = exception.path.trim_end_matches('/').to_owned();
    }
    for exception in allowlist.files.iter().chain(&allowlist.folders) {
        if exception.reason.trim().is_empty() {
            bail!("the exception for {} needs a reason", exception.path);
        }
    }
    Ok(allowlist)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_empty_list() {
        let allowlist = parse("# no exceptions\n").unwrap();
        assert_eq!(allowlist, Allowlist::default());
    }

    #[test]
    fn reads_file_and_folder_exceptions() {
        let allowlist = parse(
            r#"
            [[file]]
            path = "crates/a/src/table.rs"
            reason = "a lookup table"

            [[folder]]
            path = "crates/a/src/handlers/"
            reason = "one handler per endpoint"
            "#,
        )
        .unwrap();
        assert!(allowlist.allows_file("crates/a/src/table.rs"));
        assert!(allowlist.allows_folder("crates/a/src/handlers"));
        assert!(!allowlist.allows_file("crates/a/src/other.rs"));
    }

    #[test]
    fn refuses_an_exception_without_a_reason() {
        let missing = parse("[[file]]\npath = \"a.rs\"\n").unwrap_err();
        assert!(
            format!("{missing:#}").contains("missing field `reason`"),
            "{missing:#}"
        );

        let empty = parse("[[file]]\npath = \"a.rs\"\nreason = \"  \"\n").unwrap_err();
        assert_eq!(empty.to_string(), "the exception for a.rs needs a reason");
    }

    #[test]
    fn refuses_unknown_keys() {
        assert!(parse("[[file]]\npath = \"a.rs\"\nreason = \"x\"\nlimit = 900\n").is_err());
        assert!(parse("[[files]]\npath = \"a.rs\"\nreason = \"x\"\n").is_err());
    }
}
