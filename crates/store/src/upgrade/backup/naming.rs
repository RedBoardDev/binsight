//! The names of backup files.
//!
//! A backup is named `binsight-<UTC time>-v<binary version>-schema<schema version>.db`, so names
//! sort in chronological order and say what wrote them. A second backup in the same second gets
//! a numbered name (`…-schema1-2.db`). This module builds and recognises names; it never touches
//! the disk.

use jiff::Timestamp;

/// Every backup file name starts with this.
const FILE_PREFIX: &str = "binsight-";

/// Every backup file name ends with this.
const FILE_SUFFIX: &str = ".db";

/// The UTC time in a backup file name; it sorts in chronological order.
const TIME_FORMAT: &str = "%Y%m%dT%H%M%SZ";

/// The length of a formatted [`TIME_FORMAT`], such as `20261003T120000Z`.
const TIME_LENGTH: usize = 16;

/// The file name of a backup taken at `now` by `binary_version` of a database at `schema_version`.
pub(crate) fn backup_file_name(
    now: Timestamp,
    binary_version: &str,
    schema_version: u32,
) -> String {
    let time = now.strftime(TIME_FORMAT);
    format!("{FILE_PREFIX}{time}-v{binary_version}-schema{schema_version}{FILE_SUFFIX}")
}

/// The `number`th name for a backup whose first choice, `name`, is taken.
pub(super) fn alternative_name(name: &str, number: u32) -> String {
    let stem = name.strip_suffix(FILE_SUFFIX).unwrap_or(name);
    format!("{stem}-{number}{FILE_SUFFIX}")
}

/// Whether `name` is exactly the name of a backup made by this module.
pub(super) fn is_backup_file_name(name: &str) -> bool {
    let Some(rest) = name
        .strip_prefix(FILE_PREFIX)
        .and_then(|rest| rest.strip_suffix(FILE_SUFFIX))
    else {
        return false;
    };
    let Some((time, versions)) = rest.split_at_checked(TIME_LENGTH) else {
        return false;
    };
    let is_time = time
        .chars()
        .enumerate()
        .all(|(position, character)| match position {
            8 => character == 'T',
            15 => character == 'Z',
            _ => character.is_ascii_digit(),
        });
    is_time && versions.starts_with("-v") && versions.contains("-schema")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> Timestamp {
        Timestamp::from_second(seconds).unwrap()
    }

    #[test]
    fn names_a_backup_after_its_time_and_versions() {
        let name = backup_file_name(at(1_790_000_000), "0.1.0", 1);

        assert_eq!(name, "binsight-20260921T141320Z-v0.1.0-schema1.db");
        assert!(is_backup_file_name(&name));
    }

    #[test]
    fn numbers_a_second_backup_of_the_same_second() {
        let name = backup_file_name(at(1_790_000_000), "0.1.0", 1);

        let second = alternative_name(&name, 2);

        assert_eq!(second, "binsight-20260921T141320Z-v0.1.0-schema1-2.db");
        assert!(is_backup_file_name(&second));
    }

    #[test]
    fn recognises_only_its_own_backup_names() {
        for other in [
            "binsight.db",
            "binsight-latest.db",
            "binsight-20260921T144000Z.db",
            "binsight-20260921T144000Z-v0.1.0-schema1.db.tmp",
            "binsight-20260921T144000Z-v0.1.0-schema1.db.partial",
            "notes-20260921T144000Z-v0.1.0-schema1.db",
        ] {
            assert!(!is_backup_file_name(other), "{other}");
        }
    }
}
