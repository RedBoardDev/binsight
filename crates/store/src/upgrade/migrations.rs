//! The list of schema migrations embedded in the binary.
//!
//! Each migration is a SQL file under `crates/store/migrations/`, named `NNNN_name.sql`, and is
//! listed here explicitly, in order. A released migration is never edited (its checksum is
//! recorded when it is applied); a schema change is always a new file. This module only lists
//! them; applying them is the job of `migrate`.

/// One embedded schema migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Migration {
    /// The schema version this migration produces, counted from 1 without gaps.
    pub(crate) version: u32,
    /// A short `snake_case` name, as in the file name.
    pub(crate) name: &'static str,
    /// The SQL, run as one batch inside the upgrade transaction.
    pub(crate) sql: &'static str,
}

/// Every migration, in the order they are applied.
pub(crate) const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "foundation",
    sql: include_str!("../../migrations/0001_foundation.sql"),
}];

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    /// The migration files on disk, as `(file name, content)`, sorted by name.
    fn migration_files() -> Vec<(String, String)> {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let Ok(entries) = std::fs::read_dir(&folder) else {
            return Vec::new();
        };
        let mut files: Vec<(String, String)> = entries
            .map(|entry| entry.unwrap().path())
            .map(|path| {
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                (name, std::fs::read_to_string(&path).unwrap())
            })
            .collect();
        files.sort();
        files
    }

    #[test]
    fn lists_exactly_the_files_of_the_migrations_folder() {
        let listed: Vec<(String, String)> = MIGRATIONS
            .iter()
            .map(|migration| {
                let file = format!("{:04}_{}.sql", migration.version, migration.name);
                (file, migration.sql.to_owned())
            })
            .collect();

        assert_eq!(listed, migration_files());
    }

    #[test]
    fn numbers_the_migrations_from_one_without_gaps() {
        for (position, migration) in MIGRATIONS.iter().enumerate() {
            assert_eq!(usize::try_from(migration.version).unwrap(), position + 1);
        }
    }

    #[test]
    fn names_the_migrations_in_snake_case() {
        for migration in MIGRATIONS {
            assert_ne!(migration.name, "");
            assert!(
                migration
                    .name
                    .chars()
                    .all(|character| character.is_ascii_lowercase()
                        || character.is_ascii_digit()
                        || character == '_'),
                "{} is not snake_case",
                migration.name
            );
        }
    }
}
