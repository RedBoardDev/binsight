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
pub(crate) const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "foundation",
        sql: include_str!("../../migrations/0001_foundation.sql"),
    },
    Migration {
        version: 2,
        name: "credit_ledger",
        sql: include_str!("../../migrations/0002_credit_ledger.sql"),
    },
    Migration {
        version: 3,
        name: "wallet_ingestion",
        sql: include_str!("../../migrations/0003_wallet_ingestion.sql"),
    },
    Migration {
        version: 4,
        name: "live_credit_purposes",
        sql: include_str!("../../migrations/0004_live_credit_purposes.sql"),
    },
    Migration {
        version: 5,
        name: "wallet_signature_order",
        sql: include_str!("../../migrations/0005_wallet_signature_order.sql"),
    },
    Migration {
        version: 6,
        name: "decoded_execution",
        sql: include_str!("../../migrations/0006_decoded_execution.sql"),
    },
    Migration {
        version: 7,
        name: "drop_listing_rank",
        sql: include_str!("../../migrations/0007_drop_listing_rank.sql"),
    },
    Migration {
        version: 8,
        name: "drop_decoded_events",
        sql: include_str!("../../migrations/0008_drop_decoded_events.sql"),
    },
    Migration {
        version: 9,
        name: "open_fetch_tasks",
        sql: include_str!("../../migrations/0009_open_fetch_tasks.sql"),
    },
    Migration {
        version: 10,
        name: "wallet_listed_count",
        sql: include_str!("../../migrations/0010_wallet_listed_count.sql"),
    },
    Migration {
        version: 11,
        name: "raw_tx_never_deleted",
        sql: include_str!("../../migrations/0011_raw_tx_never_deleted.sql"),
    },
    Migration {
        version: 12,
        name: "decode_reader_version",
        sql: include_str!("../../migrations/0012_decode_reader_version.sql"),
    },
    Migration {
        version: 13,
        name: "decode_transaction_index",
        sql: include_str!("../../migrations/0013_decode_transaction_index.sql"),
    },
    Migration {
        version: 14,
        name: "wallet_repair",
        sql: include_str!("../../migrations/0014_wallet_repair.sql"),
    },
];

#[cfg(test)]
#[path = "migrations/existing_rows_tests.rs"]
mod existing_rows_tests;

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

    #[test]
    fn preserves_legacy_decode_records_without_inventing_execution_success() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let (before, added) = MIGRATIONS.split_at(5);
        for migration in before {
            connection.execute_batch(migration.sql).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO raw_tx VALUES
             ('legacy', 1, NULL, '0', 'finalized', 'base64', 'none',
              x'00', zeroblob(32), 0);
             INSERT INTO tx_decode VALUES ('legacy', 'dlmm', 1, 'decoded', NULL, 0);
             INSERT INTO decoded_event VALUES
             ('legacy', 'dlmm', 0, 1, 'dlmm.add_liquidity', '{\"amount\":\"1\"}');",
            )
            .unwrap();
        connection.execute_batch(added[0].sql).unwrap();
        let kept: (String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT outcome, execution_outcome, execution_error FROM tx_decode",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(kept, ("decoded".to_owned(), None, None));
        let payload: String = connection
            .query_row("SELECT payload FROM decoded_event", [], |row| row.get(0))
            .unwrap();
        assert_eq!(payload, "{\"amount\":\"1\"}");
    }

    #[test]
    fn starts_each_wallet_listed_count_from_its_listed_signatures() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let (before, added) = MIGRATIONS.split_at(9);
        for migration in before {
            connection.execute_batch(migration.sql).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO wallet VALUES ('a', 0), ('b', 0);
                 INSERT INTO wallet_cursor (wallet, history_state) VALUES
                     ('a', 'not_started'), ('b', 'not_started');
                 INSERT INTO wallet_signature VALUES
                     ('a', 's1', 1, NULL, 0, 0), ('a', 's2', 2, NULL, 0, 0);",
            )
            .unwrap();
        connection.execute_batch(added[0].sql).unwrap();
        let counts: Vec<(String, i64)> = connection
            .prepare("SELECT wallet, listed_count FROM wallet_cursor ORDER BY wallet")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(counts, [("a".to_owned(), 2), ("b".to_owned(), 0)]);
    }

    #[test]
    fn refuses_to_delete_a_raw_transaction_already_stored() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let (before, added) = MIGRATIONS.split_at(10);
        for migration in before {
            connection.execute_batch(migration.sql).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO raw_tx VALUES
                 ('kept', 1, NULL, '0', 'finalized', 'base64', 'none', x'00', zeroblob(32), 0);",
            )
            .unwrap();
        connection.execute_batch(added[0].sql).unwrap();

        let deleted = connection.execute("DELETE FROM raw_tx", []);

        assert!(deleted.is_err());
        let kept: i64 = connection
            .query_row("SELECT count(*) FROM raw_tx", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kept, 1);
    }

    #[test]
    fn marks_every_existing_decode_result_as_read_by_reader_zero() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let (before, added) = MIGRATIONS.split_at(11);
        for migration in before {
            connection.execute_batch(migration.sql).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO raw_tx VALUES
                 ('old', 1, NULL, '0', 'finalized', 'base64', 'none', x'00', zeroblob(32), 0);
                 INSERT INTO tx_decode (signature, decoder, decoder_version, outcome, error,
                                        decoded_at)
                 VALUES ('old', 'dlmm', 2, 'failed', 'unreadable', 0);",
            )
            .unwrap();
        connection.execute_batch(added[0].sql).unwrap();

        let kept: (i64, i64, String) = connection
            .query_row(
                "SELECT reader_version, decoder_version, outcome FROM tx_decode",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(kept, (0, 2, "failed".to_owned()));
    }

    #[test]
    fn keeps_the_credits_spent_when_their_purposes_widen() {
        let folder = tempfile::tempdir().unwrap();
        let mut connection = rusqlite::Connection::open(folder.path().join("binsight.db")).unwrap();
        let (before, widening) = MIGRATIONS.split_at(3);
        for migration in before {
            connection.execute_batch(migration.sql).unwrap();
        }
        connection
            .execute(
                "INSERT INTO credit_daily VALUES
                 ('2026-09-21', 'getTransaction', 'history', 'transaction_fetch', '', 'ok', 7, 7)",
                [],
            )
            .unwrap();

        let transaction = connection.transaction().unwrap();
        transaction.execute_batch(widening[0].sql).unwrap();
        transaction.commit().unwrap();

        let kept: i64 = connection
            .query_row("SELECT credits FROM credit_daily", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kept, 7);
        connection
            .execute(
                "INSERT INTO credit_daily VALUES
                 ('2026-09-21', 'ws_open', 'realtime', 'live_stream', '', 'ok', 1, 1)",
                [],
            )
            .unwrap();
    }
}
