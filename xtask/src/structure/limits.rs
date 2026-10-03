//! The size limits and which files they apply to.
//!
//! This module decides, from a path alone, whether a file is source code, a test or something the
//! limits ignore (generated code, fixtures, snapshots, anything that is not a source file). It
//! holds no I/O and does not count anything.

use std::path::Path;

/// A source file may never be longer than this (a hard ceiling, not a target).
pub(crate) const MAX_LINES: usize = 500;

/// A source file longer than this must be justified; aim for half of [`MAX_LINES`].
pub(crate) const REVIEW_LINES: usize = 300;

/// A folder may hold at most this many source files, tests and generated files excluded.
pub(crate) const MAX_SOURCE_FILES_PER_FOLDER: usize = 12;

/// The allowlist of exceptions, relative to the repository root.
pub(crate) const ALLOWLIST_PATH: &str = "xtask/structure-allowlist.toml";

/// How the limits treat a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileRole {
    /// Application or tooling code: the line limit applies and it counts in its folder.
    Code,
    /// A test file: the line limit applies, but it does not count in its folder.
    Test,
}

/// Folders whose content is data for tests, never code to keep small.
const IGNORED_FOLDERS: &[&str] = &["fixtures", "snapshots", "__snapshots__", "generated"];

/// Returns how the limits treat the file at `path` (relative to the repository root, with `/`
/// separators), or `None` if the limits ignore it.
pub(crate) fn classify(path: &str) -> Option<FileRole> {
    let folders: Vec<&str> = path.split('/').collect();
    let file_name = folders.last().copied().unwrap_or_default();
    if folders
        .iter()
        .any(|folder| IGNORED_FOLDERS.contains(folder))
    {
        return None;
    }
    if path.starts_with("crates/") || path.starts_with("xtask/") {
        return classify_rust(&folders, file_name);
    }
    if path.starts_with("web/src/") {
        return classify_web(file_name);
    }
    None
}

/// Rust: every `.rs` file; files under a `tests/` folder are integration tests.
fn classify_rust(folders: &[&str], file_name: &str) -> Option<FileRole> {
    if !has_extension(file_name, "rs") {
        return None;
    }
    if folders.contains(&"tests") {
        Some(FileRole::Test)
    } else {
        Some(FileRole::Code)
    }
}

/// Web: TypeScript, TSX and CSS; `*.spec.*` and `*.test.*` are tests; `*.gen.ts` is generated.
fn classify_web(file_name: &str) -> Option<FileRole> {
    const SOURCE_EXTENSIONS: &[&str] = &["ts", "tsx", "css"];
    const TEST_SUFFIXES: &[&str] = &[".spec.ts", ".spec.tsx", ".test.ts", ".test.tsx"];
    if !SOURCE_EXTENSIONS
        .iter()
        .any(|extension| has_extension(file_name, extension))
    {
        return None;
    }
    if file_name.ends_with(".gen.ts") {
        return None;
    }
    if TEST_SUFFIXES
        .iter()
        .any(|suffix| file_name.ends_with(suffix))
    {
        Some(FileRole::Test)
    } else {
        Some(FileRole::Code)
    }
}

/// Whether the file name ends with `.<extension>`, ignoring case.
fn has_extension(file_name: &str, extension: &str) -> bool {
    Path::new(file_name)
        .extension()
        .is_some_and(|found| found.eq_ignore_ascii_case(extension))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn treats_rust_sources_as_code() {
        assert_eq!(classify("crates/core/src/units.rs"), Some(FileRole::Code));
        assert_eq!(classify("xtask/src/main.rs"), Some(FileRole::Code));
    }

    #[test]
    fn treats_integration_tests_as_tests() {
        assert_eq!(classify("crates/api/tests/health.rs"), Some(FileRole::Test));
        assert_eq!(
            classify("crates/api/tests/common/mod.rs"),
            Some(FileRole::Test)
        );
    }

    #[test]
    fn treats_web_sources_and_specs_by_name() {
        assert_eq!(classify("web/src/main.tsx"), Some(FileRole::Code));
        assert_eq!(classify("web/src/styles/globals.css"), Some(FileRole::Code));
        assert_eq!(
            classify("web/src/Auth/Domain/safeRedirect.spec.ts"),
            Some(FileRole::Test)
        );
        assert_eq!(classify("web/src/core/App.test.tsx"), Some(FileRole::Test));
    }

    #[test]
    fn ignores_generated_files_fixtures_and_snapshots() {
        assert_eq!(classify("web/src/routeTree.gen.ts"), None);
        assert_eq!(classify("web/src/lib/api/generated/openapi.d.ts"), None);
        assert_eq!(classify("web/src/generated/client.ts"), None);
        assert_eq!(classify("xtask/tests/fixtures/metadata.rs"), None);
        assert_eq!(classify("crates/api/tests/snapshots/health.rs"), None);
    }

    #[test]
    fn ignores_files_that_are_not_source_code() {
        assert_eq!(classify("Cargo.lock"), None);
        assert_eq!(classify("openapi/v1.json"), None);
        assert_eq!(
            classify("crates/store/migrations/0001_foundation.sql"),
            None
        );
        assert_eq!(classify("web/src/locales/fr/messages.po"), None);
        assert_eq!(classify("web/vite.config.ts"), None);
        assert_eq!(classify("README.md"), None);
    }
}
