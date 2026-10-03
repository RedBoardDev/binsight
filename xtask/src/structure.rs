//! Checks that source files and folders stay small.
//!
//! A source file has at most 500 lines and a folder at most 12 source files (tests and generated
//! files excluded); files over 300 lines get a warning. The only way around a limit is an entry,
//! with a reason, in `xtask/structure-allowlist.toml`. This module applies the limits; the limits
//! themselves and which files they cover live in `structure/limits.rs`.

mod allowlist;
mod finding;
mod limits;
mod tracked_files;

use std::collections::BTreeMap;

use anyhow::Context;

use self::allowlist::Allowlist;
pub(crate) use self::finding::Finding;
use self::limits::{
    ALLOWLIST_PATH, FileRole, MAX_LINES, MAX_SOURCE_FILES_PER_FOLDER, REVIEW_LINES, classify,
};
use self::tracked_files::TrackedFile;

/// The outcome of the structure check.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Report {
    /// Broken limits; any of them fails the check.
    pub(crate) errors: Vec<Finding>,
    /// Files that need a justification; they do not fail the check.
    pub(crate) warnings: Vec<Finding>,
    /// How many source files the limits were applied to.
    pub(crate) checked_files: usize,
}

/// Reads the repository and its allowlist, then applies the limits.
pub(crate) fn check_repository() -> anyhow::Result<Report> {
    let root = tracked_files::repository_root()?;
    let allowlist_text = std::fs::read_to_string(root.join(ALLOWLIST_PATH))
        .with_context(|| format!("could not read {ALLOWLIST_PATH}"))?;
    let allowlist =
        allowlist::parse(&allowlist_text).with_context(|| format!("in {ALLOWLIST_PATH}"))?;
    let files = tracked_files::list_source_files(&root)?;
    Ok(check(&files, &allowlist))
}

/// Applies the limits to these files. Files the limits ignore are skipped.
fn check(files: &[TrackedFile], allowlist: &Allowlist) -> Report {
    let mut report = Report::default();
    let mut source_files_per_folder: BTreeMap<&str, usize> = BTreeMap::new();

    for file in files {
        let Some(role) = classify(&file.path) else {
            continue;
        };
        report.checked_files = report.checked_files.saturating_add(1);
        check_length(file, allowlist, &mut report);
        if role == FileRole::Code {
            let count = source_files_per_folder
                .entry(folder_of(&file.path))
                .or_default();
            *count = count.saturating_add(1);
        }
    }

    for (folder, &source_files) in &source_files_per_folder {
        if source_files > MAX_SOURCE_FILES_PER_FOLDER && !allowlist.allows_folder(folder) {
            report.errors.push(Finding::FolderTooCrowded {
                folder: (*folder).to_owned(),
                source_files,
            });
        }
    }

    report_unneeded_exceptions(files, &source_files_per_folder, allowlist, &mut report);
    report
}

fn check_length(file: &TrackedFile, allowlist: &Allowlist, report: &mut Report) {
    let path = file.path.clone();
    let lines = file.lines;
    if lines > MAX_LINES && !allowlist.allows_file(&file.path) {
        report.errors.push(Finding::FileTooLong { path, lines });
    } else if lines > REVIEW_LINES && lines <= MAX_LINES {
        report
            .warnings
            .push(Finding::FileNeedsJustification { path, lines });
    }
}

/// An exception whose file or folder is now within the limits (or gone) must be removed.
fn report_unneeded_exceptions(
    files: &[TrackedFile],
    source_files_per_folder: &BTreeMap<&str, usize>,
    allowlist: &Allowlist,
    report: &mut Report,
) {
    for exception in &allowlist.files {
        let still_too_long = files
            .iter()
            .any(|file| file.path == exception.path && file.lines > MAX_LINES);
        if !still_too_long {
            report.errors.push(Finding::UnneededException {
                path: exception.path.clone(),
            });
        }
    }
    for exception in &allowlist.folders {
        let count = source_files_per_folder
            .get(exception.path.as_str())
            .copied()
            .unwrap_or(0);
        if count <= MAX_SOURCE_FILES_PER_FOLDER {
            report.errors.push(Finding::UnneededException {
                path: exception.path.clone(),
            });
        }
    }
}

/// The folder of a path: everything before its last `/`.
fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| folder)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, lines: usize) -> TrackedFile {
        TrackedFile {
            path: path.to_owned(),
            lines,
        }
    }

    /// `count` Rust files named `file_0.rs`, `file_1.rs`… in `folder`.
    fn folder_with(folder: &str, count: usize) -> Vec<TrackedFile> {
        (0..count)
            .map(|index| file(&format!("{folder}/file_{index}.rs"), 10))
            .collect()
    }

    fn errors(files: &[TrackedFile], allowlist: &Allowlist) -> Vec<String> {
        let report = check(files, allowlist);
        report.errors.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn accepts_files_and_folders_exactly_at_the_limits() {
        let mut files = folder_with("crates/a/src", 10);
        files.push(file("crates/a/src/long.rs", 300));
        files.push(file("crates/a/src/longest.rs", 500));
        let report = check(&files, &Allowlist::default());
        assert_eq!(report.errors, Vec::new());
        assert_eq!(report.checked_files, 12);
    }

    #[test]
    fn rejects_a_file_over_the_line_limit_with_its_count() {
        let files = [file("crates/a/src/big.rs", 501)];
        assert_eq!(
            errors(&files, &Allowlist::default()),
            ["crates/a/src/big.rs: 501 lines (limit 500); split it by responsibility"]
        );
    }

    #[test]
    fn warns_about_files_that_need_a_justification() {
        let files = [file("crates/a/src/medium.rs", 301)];
        let report = check(&files, &Allowlist::default());
        assert_eq!(report.errors, Vec::new());
        assert_eq!(
            report.warnings,
            [Finding::FileNeedsJustification {
                path: "crates/a/src/medium.rs".to_owned(),
                lines: 301
            }]
        );
    }

    #[test]
    fn rejects_a_crowded_folder_with_its_count() {
        let files = folder_with("web/src/core", 13);
        let files: Vec<TrackedFile> = files
            .into_iter()
            .map(|f| file(&f.path.replace(".rs", ".ts"), f.lines))
            .collect();
        assert_eq!(
            errors(&files, &Allowlist::default()),
            ["web/src/core/: 13 source files (limit 12); group them into sub-modules by concept"]
        );
    }

    #[test]
    fn does_not_count_tests_or_ignored_files_in_a_folder() {
        let mut files = folder_with("web/src/core", 12);
        files.push(file("web/src/core/a.spec.ts", 10));
        files.push(file("web/src/core/b.test.tsx", 10));
        files.push(file("web/src/core/routeTree.gen.ts", 9000));
        files.push(file("web/src/core/notes.md", 10));
        let mut tests = folder_with("crates/a/tests", 20);
        files.append(&mut tests);
        assert_eq!(errors(&files, &Allowlist::default()), Vec::<String>::new());
    }

    #[test]
    fn applies_the_line_limit_to_tests_too() {
        let files = [file("crates/a/tests/huge.rs", 800)];
        assert_eq!(errors(&files, &Allowlist::default()).len(), 1);
    }

    #[test]
    fn honors_explicit_exceptions() {
        let mut files = folder_with("crates/a/src/handlers", 13);
        files.push(file("crates/a/src/table.rs", 900));
        let allowlist = allowlist::parse(
            "[[file]]\npath = \"crates/a/src/table.rs\"\nreason = \"a table\"\n\
             [[folder]]\npath = \"crates/a/src/handlers\"\nreason = \"one per route\"\n",
        )
        .unwrap();
        assert_eq!(errors(&files, &allowlist), Vec::<String>::new());
    }

    #[test]
    fn rejects_exceptions_that_are_no_longer_needed() {
        let files = [file("crates/a/src/table.rs", 120)];
        let allowlist = allowlist::parse(
            "[[file]]\npath = \"crates/a/src/table.rs\"\nreason = \"a table\"\n\
             [[folder]]\npath = \"crates/a/src/gone\"\nreason = \"was big\"\n",
        )
        .unwrap();
        assert_eq!(
            errors(&files, &allowlist),
            [
                "xtask/structure-allowlist.toml: the exception for crates/a/src/table.rs \
                 is no longer needed; remove it",
                "xtask/structure-allowlist.toml: the exception for crates/a/src/gone \
                 is no longer needed; remove it",
            ]
        );
    }
}
