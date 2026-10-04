//! Finding the backup a new copy would duplicate.
//!
//! A start that keeps failing after its backup would otherwise add a copy of the same database on
//! every attempt. `VACUUM INTO` of an unchanged database produces the same bytes, so the newest
//! backup of the same binary and schema versions is compared with the new copy, byte for byte.
//! This module only reads files.

use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::naming::is_backup_file_name;

/// How much of each file is compared at a time when looking for an identical backup.
const COMPARE_BLOCK_BYTES: usize = 1 << 20;

/// The newest backup in `folder` taken by `binary_version` of a database at `schema_version`.
pub(super) fn latest_backup_of(
    folder: &Path,
    binary_version: &str,
    schema_version: u32,
) -> Option<PathBuf> {
    let versions = format!("-v{binary_version}-schema{schema_version}");
    std::fs::read_dir(folder)
        .ok()?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| is_backup_file_name(name) && name.contains(&versions))
        .max()
        .map(|name| folder.join(name))
}

/// Whether two files hold exactly the same bytes, read a block at a time (a database can be
/// larger than the memory it is worth using).
pub(super) fn has_same_content(first: &Path, second: &Path) -> io::Result<bool> {
    if std::fs::metadata(first)?.len() != std::fs::metadata(second)?.len() {
        return Ok(false);
    }
    let mut first = BufReader::with_capacity(COMPARE_BLOCK_BYTES, File::open(first)?);
    let mut second = BufReader::with_capacity(COMPARE_BLOCK_BYTES, File::open(second)?);
    loop {
        let first_block = first.fill_buf()?;
        let second_block = second.fill_buf()?;
        let length = first_block.len().min(second_block.len());
        if length == 0 {
            return Ok(first_block.len() == second_block.len());
        }
        if first_block.get(..length) != second_block.get(..length) {
            return Ok(false);
        }
        first.consume(length);
        second.consume(length);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_files_byte_for_byte() {
        let folder = tempfile::tempdir().unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let path = folder.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            path
        };
        let large = vec![7_u8; COMPARE_BLOCK_BYTES * 2 + 3];
        let mut changed_at_the_end = large.clone();
        *changed_at_the_end.last_mut().unwrap() = 8;

        let original = write("original", &large);
        let same = write("same", &large);
        let different = write("different", &changed_at_the_end);
        let shorter = write("shorter", &large[1..]);

        assert!(has_same_content(&original, &same).unwrap());
        assert!(!has_same_content(&original, &different).unwrap());
        assert!(!has_same_content(&original, &shorter).unwrap());
    }

    #[test]
    fn finds_the_newest_backup_of_the_same_versions() {
        let folder = tempfile::tempdir().unwrap();
        for name in [
            "binsight-20260101T000000Z-v0.2.0-schema1.db",
            "binsight-20260102T000000Z-v0.2.0-schema1.db",
            "binsight-20260103T000000Z-v0.3.0-schema1.db",
            "binsight-20260104T000000Z-v0.2.0-schema1.db.partial",
        ] {
            std::fs::write(folder.path().join(name), b"").unwrap();
        }

        let latest = latest_backup_of(folder.path(), "0.2.0", 1).unwrap();

        assert_eq!(
            latest,
            folder
                .path()
                .join("binsight-20260102T000000Z-v0.2.0-schema1.db")
        );
        assert_eq!(latest_backup_of(folder.path(), "0.2.0", 2), None);
    }
}
