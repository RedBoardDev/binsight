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
    Migration {
        version: 15,
        name: "wallet_token_accounts",
        sql: include_str!("../../migrations/0015_wallet_token_accounts.sql"),
    },
];

#[cfg(test)]
#[path = "migrations/existing_rows_tests.rs"]
mod existing_rows_tests;

#[cfg(test)]
#[path = "migrations/tests.rs"]
mod tests;
