//! Writing captured fixtures all at once, or not at all.
//!
//! Files are written into a hidden staging folder (or file) next to their destination, then moved
//! into place with one rename. A failed write removes the staging copy, so it never leaves half a
//! case on disk to block the next capture with "already exists". This module only writes; it does
//! not decide what to write.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};

/// The prefix of a staging folder or file; the leading dot hides it from the fixture readers.
const STAGING_PREFIX: &str = ".capture-";

/// A file to write, relative to its destination folder, and its content.
pub(crate) struct PendingFile {
    /// The path, relative to the destination folder.
    pub(crate) path: PathBuf,
    /// The content.
    pub(crate) content: String,
}

/// Creates `folder` holding exactly `files`; refuses an existing `folder`.
pub(crate) fn write_new_folder(folder: &Path, files: &[PendingFile]) -> anyhow::Result<()> {
    let parent = parent_of(folder)?;
    let staging = tempfile::Builder::new()
        .prefix(STAGING_PREFIX)
        .tempdir_in(parent)
        .with_context(|| format!("could not create a staging folder in {}", parent.display()))?;
    for file in files {
        let path = staging.path().join(&file.path);
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder)
                .with_context(|| format!("could not create {}", folder.display()))?;
        }
        std::fs::write(&path, &file.content)
            .with_context(|| format!("could not write {}", path.display()))?;
    }
    if folder.exists() {
        bail!("{} appeared during the capture", folder.display());
    }
    std::fs::rename(staging.path(), folder)
        .with_context(|| format!("could not move the capture into {}", folder.display()))?;
    // The staging folder is now `folder`: there is nothing left to clean up.
    let _moved_into_place = staging.keep();
    Ok(())
}

/// Creates the file `path` with `content`; refuses an existing file.
pub(crate) fn write_new_file(path: &Path, content: &str) -> anyhow::Result<()> {
    let parent = parent_of(path)?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("could not create {}", parent.display()))?;
    let mut staging = tempfile::Builder::new()
        .prefix(STAGING_PREFIX)
        .tempfile_in(parent)
        .with_context(|| format!("could not create a staging file in {}", parent.display()))?;
    staging
        .write_all(content.as_bytes())
        .with_context(|| format!("could not write {}", staging.path().display()))?;
    staging
        .persist_noclobber(path)
        .map_err(|error| error.error)
        .with_context(|| format!("could not move the answer into {}", path.display()))?;
    Ok(())
}

fn parent_of(path: &Path) -> anyhow::Result<&Path> {
    path.parent()
        .with_context(|| format!("{} has no parent folder", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(path: &str, content: &str) -> PendingFile {
        PendingFile {
            path: PathBuf::from(path),
            content: content.to_owned(),
        }
    }

    #[test]
    fn moves_every_file_of_a_case_into_place_at_once() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("case");
        let files = [pending("tx-1.json", "{}"), pending("accounts/a.json", "[]")];
        write_new_folder(&folder, &files).unwrap();
        assert_eq!(
            std::fs::read_to_string(folder.join("tx-1.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            std::fs::read_to_string(folder.join("accounts/a.json")).unwrap(),
            "[]"
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn leaves_nothing_behind_when_a_file_cannot_be_written() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("case");
        let files = [
            pending("tx-1.json", "{}"),
            pending("tx-1.json/inside", "{}"),
        ];
        assert!(write_new_folder(&folder, &files).is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn never_overwrites_a_recorded_answer() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("getSlot/current.json");
        write_new_file(&path, "1").unwrap();
        assert!(write_new_file(&path, "2").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "1");
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
    }
}
