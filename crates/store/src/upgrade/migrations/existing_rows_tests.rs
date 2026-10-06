//! What the migrations from 0013 on do to the rows a database already holds.

use super::MIGRATIONS;

/// An in-memory database migrated up to `version` included.
fn migrated_to(version: usize) -> rusqlite::Connection {
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    for migration in &MIGRATIONS[..version] {
        connection.execute_batch(migration.sql).unwrap();
    }
    connection
}

#[test]
fn decodes_every_existing_result_again_to_learn_its_transaction_index() {
    let connection = migrated_to(12);
    connection
        .execute_batch(
            "INSERT INTO raw_tx VALUES
             ('old', 1, NULL, '0', 'finalized', 'base64', 'none', x'00', zeroblob(32), 0);
             INSERT INTO tx_decode (signature, decoder, decoder_version, outcome, error,
                                    decoded_at, reader_version)
             VALUES ('old', 'dlmm', 2, 'decoded', NULL, 0, 1);",
        )
        .unwrap();

    connection.execute_batch(MIGRATIONS[12].sql).unwrap();

    let kept: (i64, i64, Option<i64>, String) = connection
        .query_row(
            "SELECT reader_version, decoder_version, transaction_index, outcome FROM tx_decode",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(kept, (0, 2, None, "decoded".to_owned()));
    let negative = connection.execute("UPDATE tx_decode SET transaction_index = -1", []);
    assert!(negative.is_err());
}

#[test]
fn keeps_the_credits_spent_when_the_repair_gets_a_purpose_of_its_own() {
    let connection = migrated_to(13);
    connection
        .execute_batch(
            "INSERT INTO credit_daily VALUES
             ('2026-09-21', 'getTransaction', 'history', 'transaction_fetch', '', 'ok', 7, 7);",
        )
        .unwrap();

    connection.execute_batch(MIGRATIONS[13].sql).unwrap();

    let kept: i64 = connection
        .query_row("SELECT credits FROM credit_daily", [], |row| row.get(0))
        .unwrap();
    assert_eq!(kept, 7);
    connection
        .execute_batch(
            "INSERT INTO credit_daily VALUES
             ('2026-09-21', 'getSignaturesForAddress', 'history', 'repair', '', 'ok', 1, 1);",
        )
        .unwrap();
}

#[test]
fn keeps_the_credits_spent_when_the_balance_checks_get_purposes_of_their_own() {
    let connection = migrated_to(14);
    connection
        .execute_batch(
            "INSERT INTO credit_daily VALUES
             ('2026-09-21', 'getSignaturesForAddress', 'history', 'repair', '', 'ok', 2, 2);",
        )
        .unwrap();

    connection.execute_batch(MIGRATIONS[14].sql).unwrap();

    let kept: i64 = connection
        .query_row("SELECT credits FROM credit_daily", [], |row| row.get(0))
        .unwrap();
    assert_eq!(kept, 2);
    connection
        .execute_batch(
            "INSERT INTO credit_daily VALUES
             ('2026-09-21', 'getMultipleAccounts', 'history', 'balance_check', '', 'ok', 1, 1),
             ('2026-09-21', 'getSignaturesForAddress', 'catch_up', 'token_account_listing', '',
              'ok', 1, 1);",
        )
        .unwrap();
}
