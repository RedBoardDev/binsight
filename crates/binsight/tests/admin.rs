//! `binsight admin` and `binsight healthcheck` against a real data folder and server.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod common;

use std::process::Output;

use common::{Server, as_pairs, binsight, valid_variables};

async fn run(home: &std::path::Path, arguments: &[&str], variables: &[(&str, &str)]) -> Output {
    binsight(home, arguments, variables).output().await.unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

#[tokio::test]
async fn reports_healthy_and_backs_up_while_the_server_runs() {
    let home = tempfile::tempdir().unwrap();
    let variables = valid_variables(home.path(), "127.0.0.1:0");
    let server = Server::start(home.path(), &as_pairs(&variables)).await;
    let mut probe = variables.clone();
    probe.retain(|(name, _)| *name != "BINSIGHT_BIND");
    probe.push(("BINSIGHT_BIND", server.address.clone()));

    let health = run(home.path(), &["healthcheck"], &as_pairs(&probe)).await;
    let backup = run(home.path(), &["admin", "backup"], &as_pairs(&probe)).await;
    let rotation = run(
        home.path(),
        &["admin", "rotate-sessions"],
        &as_pairs(&probe),
    )
    .await;

    assert_eq!(health.status.code(), Some(0));
    assert_eq!(backup.status.code(), Some(0), "{backup:?}");
    assert!(
        stdout(&backup).contains("-schema3.db"),
        "{}",
        stdout(&backup)
    );
    assert_eq!(
        rotation.status.code(),
        Some(75),
        "the server holds the lock"
    );
    server.send_sigterm().await;
}

#[tokio::test]
async fn reports_unhealthy_when_no_server_answers() {
    let home = tempfile::tempdir().unwrap();
    let variables = valid_variables(home.path(), "127.0.0.1:9");

    let health = run(home.path(), &["healthcheck"], &as_pairs(&variables)).await;

    assert_ne!(health.status.code(), Some(0));
}

#[tokio::test]
async fn shows_the_schema_and_signs_everyone_out_once_stopped() {
    let home = tempfile::tempdir().unwrap();
    let variables = valid_variables(home.path(), "127.0.0.1:0");
    let server = Server::start(home.path(), &as_pairs(&variables)).await;
    server.send_sigterm().await;
    let mut child = server.child;
    child.wait().await.unwrap();

    let status = run(home.path(), &["admin", "db-status"], &as_pairs(&variables)).await;
    let rotation = run(
        home.path(),
        &["admin", "rotate-sessions"],
        &as_pairs(&variables),
    )
    .await;

    assert_eq!(status.status.code(), Some(0));
    assert!(stdout(&status).starts_with("Schema version: 3 (this binsight knows up to 3)"));
    assert_eq!(rotation.status.code(), Some(0));
    assert!(stdout(&rotation).contains("Every session is signed out"));
}

#[tokio::test]
async fn shows_the_configuration_without_its_secrets() {
    let home = tempfile::tempdir().unwrap();
    let variables = valid_variables(home.path(), "127.0.0.1:0");

    let output = run(home.path(), &["admin", "config"], &as_pairs(&variables)).await;

    let shown = stdout(&output);
    assert_eq!(output.status.code(), Some(0));
    assert!(
        shown.contains("BINSIGHT_PASSWORD=(set) (from the environment)"),
        "{shown}"
    );
    assert!(!shown.contains(common::PASSWORD), "{shown}");
    assert!(!shown.contains("test-placeholder-key"), "{shown}");
}

#[tokio::test]
async fn tracks_a_wallet_and_reports_its_import_once_stopped() {
    let home = tempfile::tempdir().unwrap();
    let variables = valid_variables(home.path(), "127.0.0.1:0");
    let server = Server::start(home.path(), &as_pairs(&variables)).await;
    server.send_sigterm().await;
    let mut child = server.child;
    child.wait().await.unwrap();
    let wallet = "11111111111111111111111111111111";
    let signature = "1".repeat(64);

    let added = run(
        home.path(),
        &["admin", "wallet-add", wallet],
        &as_pairs(&variables),
    )
    .await;
    let again = run(
        home.path(),
        &["admin", "wallet-add", wallet],
        &as_pairs(&variables),
    )
    .await;
    let status = run(
        home.path(),
        &["admin", "sync-status"],
        &as_pairs(&variables),
    )
    .await;
    let export = run(
        home.path(),
        &["admin", "export-tx", &signature],
        &as_pairs(&variables),
    )
    .await;

    assert_eq!(added.status.code(), Some(0), "{added:?}");
    assert!(stdout(&added).starts_with(&format!("Tracking {wallet}")));
    assert!(stdout(&again).contains("already tracked"));
    let shown = stdout(&status);
    assert!(
        shown.contains(&format!("Wallet {wallet}\n  history: not listed yet")),
        "{shown}"
    );
    assert!(shown.contains("Credits today"), "{shown}");
    assert_eq!(export.status.code(), Some(64));
}

#[tokio::test]
async fn tracks_a_wallet_before_the_first_run() {
    let home = tempfile::tempdir().unwrap();
    let variables = valid_variables(home.path(), "127.0.0.1:0");
    let wallet = "11111111111111111111111111111111";

    let added = run(
        home.path(),
        &["admin", "wallet-add", wallet],
        &as_pairs(&variables),
    )
    .await;
    let status = run(
        home.path(),
        &["admin", "sync-status"],
        &as_pairs(&variables),
    )
    .await;

    assert_eq!(added.status.code(), Some(0), "{added:?}");
    assert!(stdout(&status).contains(&format!("Wallet {wallet}")));
}

#[tokio::test]
async fn refuses_an_address_that_is_not_base58() {
    let home = tempfile::tempdir().unwrap();
    let variables = valid_variables(home.path(), "127.0.0.1:0");

    let output = run(
        home.path(),
        &["admin", "wallet-add", "not-an-address"],
        &as_pairs(&variables),
    )
    .await;

    assert_eq!(output.status.code(), Some(2));
}
