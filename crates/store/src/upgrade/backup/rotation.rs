//! Deleting the oldest backups, so the folder holds a bounded number of them.
//!
//! Only whole backups count: a `.partial` file is a copy that never finished (the process was
//! killed while writing it), so it is deleted rather than kept in place of a real backup. Files
//! whose name is not a backup name are never touched. This module only deletes.

use std::io;
use std::path::{Path, PathBuf};

use super::PARTIAL_SUFFIX;
use super::naming::is_backup_file_name;

/// Deletes the oldest backups in `folder`, keeping the `keep` most recent, and the partial copies
/// left by interrupted backups. Returns the deleted files.
pub(crate) fn rotate_backups(folder: &Path, keep: usize) -> io::Result<Vec<PathBuf>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_owned());
        }
    }
    let mut deleted = Vec::new();
    for name in files_to_delete(names, keep) {
        let path = folder.join(name);
        std::fs::remove_file(&path)?;
        deleted.push(path);
    }
    Ok(deleted)
}

/// The partial copies, then the backups to delete so that only the `keep` most recent remain.
fn files_to_delete(names: Vec<String>, keep: usize) -> Vec<String> {
    let (partials, others): (Vec<String>, Vec<String>) =
        names.into_iter().partition(|name| is_partial_backup(name));
    let mut backups: Vec<String> = others
        .into_iter()
        .filter(|name| is_backup_file_name(name))
        .collect();
    backups.sort();
    let excess = backups.len().saturating_sub(keep);
    backups.truncate(excess);
    partials.into_iter().chain(backups).collect()
}

/// Whether `name` is a backup that was never finished.
fn is_partial_backup(name: &str) -> bool {
    name.strip_suffix(PARTIAL_SUFFIX)
        .is_some_and(is_backup_file_name)
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;

    use super::*;
    use crate::upgrade::backup::backup_file_name;

    fn backup_on_day(day: i64) -> String {
        let now = Timestamp::from_second(1_790_000_000 + day * 86_400).unwrap();
        backup_file_name(now, "0.1.0", 1)
    }

    #[test]
    fn deletes_the_oldest_backups_beyond_the_kept_count() {
        let names: Vec<String> = [3, 1, 4, 2]
            .into_iter()
            .map(backup_on_day)
            .chain(["keep-me.db".to_owned()])
            .collect();

        let deleted = files_to_delete(names, 3);

        assert_eq!(deleted, vec![backup_on_day(1)]);
    }

    #[test]
    fn deletes_nothing_when_there_are_few_backups() {
        let names = vec![backup_on_day(0)];
        assert_eq!(files_to_delete(names, 3), Vec::<String>::new());
    }

    #[test]
    fn never_counts_a_partial_copy_as_a_backup() {
        let partial = format!("{}{PARTIAL_SUFFIX}", backup_on_day(9));
        let names = vec![
            backup_on_day(1),
            backup_on_day(2),
            partial.clone(),
            "notes.db.partial".to_owned(),
        ];

        let deleted = files_to_delete(names, 2);

        assert_eq!(deleted, vec![partial]);
    }

    #[test]
    fn deletes_the_files_on_disk() {
        let folder = tempfile::tempdir().unwrap();
        for name in [backup_on_day(1), backup_on_day(2), "keep-me.db".to_owned()] {
            std::fs::write(folder.path().join(name), b"").unwrap();
        }

        let deleted = rotate_backups(folder.path(), 1).unwrap();

        assert_eq!(deleted, vec![folder.path().join(backup_on_day(1))]);
        assert!(folder.path().join("keep-me.db").exists());
    }
}
