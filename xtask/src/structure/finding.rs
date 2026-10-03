//! What the structure check found, and how it is explained to a human.
//!
//! Each finding names the offending path with its count and the limit. This module only describes
//! findings; the check that produces them lives in `structure.rs`.

use std::fmt;

use super::limits::{ALLOWLIST_PATH, MAX_LINES, MAX_SOURCE_FILES_PER_FOLDER, REVIEW_LINES};

/// One result of the structure check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Finding {
    /// A file is longer than the hard limit. Fails the check.
    FileTooLong {
        /// The file, relative to the repository root.
        path: String,
        /// Its number of lines.
        lines: usize,
    },
    /// A folder holds more source files than the limit. Fails the check.
    FolderTooCrowded {
        /// The folder, relative to the repository root.
        folder: String,
        /// Its number of source files (tests and generated files excluded).
        source_files: usize,
    },
    /// An allowlisted file or folder is now within the limits (or gone). Fails the check, so the
    /// allowlist only ever shrinks.
    UnneededException {
        /// The path named by the exception.
        path: String,
    },
    /// A file is within the hard limit but long enough to need a justification. Only a warning.
    FileNeedsJustification {
        /// The file, relative to the repository root.
        path: String,
        /// Its number of lines.
        lines: usize,
    },
}

impl fmt::Display for Finding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FileTooLong { path, lines } => write!(
                formatter,
                "{path}: {lines} lines (limit {MAX_LINES}); split it by responsibility"
            ),
            Self::FolderTooCrowded {
                folder,
                source_files,
            } => write!(
                formatter,
                "{folder}/: {source_files} source files (limit {MAX_SOURCE_FILES_PER_FOLDER}); \
                 group them into sub-modules by concept"
            ),
            Self::UnneededException { path } => write!(
                formatter,
                "{ALLOWLIST_PATH}: the exception for {path} is no longer needed; remove it"
            ),
            Self::FileNeedsJustification { path, lines } => write!(
                formatter,
                "{path}: {lines} lines (over {REVIEW_LINES}); justify it or split it"
            ),
        }
    }
}
