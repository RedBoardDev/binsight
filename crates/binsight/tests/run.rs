//! `binsight run` as a real process: exit codes and graceful shutdown.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod common;

use std::time::{Duration, Instant};

use common::{Server, as_pairs, binsight, valid_variables};

#[tokio::test]
async fn exits_with_78_and_names_the_variable_when_the_password_is_missing() {
    let home = tempfile::tempdir().unwrap();
    let output = binsight(home.path(), &["run"], &[("BINSIGHT_HELIUS_API_KEY", "x")])
        .output()
        .await
        .unwrap();

    assert_eq!(output.status.code(), Some(78));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("BINSIGHT_PASSWORD: required"), "{stderr}");
}

#[tokio::test]
async fn exits_with_78_when_the_password_is_too_short() {
    let home = tempfile::tempdir().unwrap();
    let variables = [
        ("BINSIGHT_HELIUS_API_KEY", "x"),
        ("BINSIGHT_PASSWORD", "8letters"),
    ];
    let output = binsight(home.path(), &["run"], &variables)
        .output()
        .await
        .unwrap();

    assert_eq!(output.status.code(), Some(78));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("at least 12 characters"), "{stderr}");
}

#[tokio::test]
async fn exits_with_75_when_another_server_uses_the_data_folder() {
    let home = tempfile::tempdir().unwrap();
    let variables = valid_variables(home.path(), "127.0.0.1:0");
    let first = Server::start(home.path(), &as_pairs(&variables)).await;

    let second = binsight(home.path(), &["run"], &as_pairs(&variables))
        .output()
        .await
        .unwrap();

    assert_eq!(second.status.code(), Some(75));
    let stderr = String::from_utf8(second.stderr).unwrap();
    assert!(
        stderr.contains("another binsight is already running"),
        "{stderr}"
    );
    first.send_sigterm().await;
}

#[tokio::test]
async fn stops_cleanly_within_two_seconds_on_sigterm() {
    let home = tempfile::tempdir().unwrap();
    let variables = valid_variables(home.path(), "127.0.0.1:0");
    let mut server = Server::start(home.path(), &as_pairs(&variables)).await;

    let asked_at = Instant::now();
    server.send_sigterm().await;
    server.wait_for_line("shutdown complete").await;
    let status = server.child.wait().await.unwrap();

    assert!(
        asked_at.elapsed() < Duration::from_secs(2),
        "{:?}",
        asked_at.elapsed()
    );
    assert_eq!(status.code(), Some(0));
}
