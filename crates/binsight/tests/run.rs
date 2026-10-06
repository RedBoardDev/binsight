//! `binsight run` as a real process: exit codes and graceful shutdown.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod common;

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

// An overrun of the shutdown deadline exits 1, so the exit code alone proves the stop was in
// time, without timing a real process on a machine that may be busy.
#[tokio::test]
async fn stops_cleanly_on_sigterm() {
    let home = tempfile::tempdir().unwrap();
    let variables = valid_variables(home.path(), "127.0.0.1:0");
    let mut server = Server::start(home.path(), &as_pairs(&variables)).await;

    server.send_sigterm().await;
    server.wait_for_line("shutdown complete").await;
    let status = server.child.wait().await.unwrap();

    assert_eq!(status.code(), Some(0));
}

#[tokio::test]
async fn serves_the_demo_world_without_a_helius_key() {
    let home = tempfile::tempdir().unwrap();
    let data = home.path().join("data").display().to_string();
    let variables = [
        ("BINSIGHT_PASSWORD", common::PASSWORD),
        ("BINSIGHT_DATA_DIR", data.as_str()),
        ("BINSIGHT_BIND", "127.0.0.1:0"),
        ("BINSIGHT_DEMO", "true"),
    ];
    let server = Server::start(home.path(), &variables).await;

    let health = get_health(&server.address).await;

    assert!(health.contains(r#""data_source":"demo""#), "{health}");
    server.send_sigterm().await;
}

#[tokio::test]
async fn runs_the_demo_beside_a_real_instance_without_touching_its_database() {
    let home = tempfile::tempdir().unwrap();
    let variables = valid_variables(home.path(), "127.0.0.1:0");
    add_a_wallet(home.path(), &as_pairs(&variables)).await;
    let data = home.path().join("data");
    let real = folder_contents(&data);
    let mut demo = as_pairs(&variables);
    demo.push(("BINSIGHT_DEMO", "true"));

    let server = Server::start(home.path(), &demo).await;
    let health = get_health(&server.address).await;
    server.send_sigterm().await;

    assert!(health.contains(r#""data_source":"demo""#), "{health}");
    assert!(data.join("demo").join("binsight.db").is_file());
    assert_eq!(folder_contents(&data), real);
}

#[tokio::test]
async fn refuses_a_demo_folder_that_tracks_wallets_before_changing_it() {
    let home = tempfile::tempdir().unwrap();
    let mut tracking_demo_folder = valid_variables(home.path(), "127.0.0.1:0");
    let demo_folder = home.path().join("data").join("demo");
    let demo_folder_text = demo_folder.display().to_string();
    for (name, value) in &mut tracking_demo_folder {
        if *name == "BINSIGHT_DATA_DIR" {
            value.clone_from(&demo_folder_text);
        }
    }
    add_a_wallet(home.path(), &as_pairs(&tracking_demo_folder)).await;
    let before = folder_contents(&demo_folder);
    let variables = valid_variables(home.path(), "127.0.0.1:0");
    let mut demo = as_pairs(&variables);
    demo.push(("BINSIGHT_DEMO", "true"));

    let output = binsight(home.path(), &["run"], &demo)
        .output()
        .await
        .unwrap();

    assert_eq!(output.status.code(), Some(78));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("because it tracks wallets"), "{stderr}");
    assert_eq!(folder_contents(&demo_folder), before);
}

/// Tracks a wallet in the data folder `variables` name.
async fn add_a_wallet(home: &std::path::Path, variables: &[(&str, &str)]) {
    let added = binsight(
        home,
        &["admin", "wallet-add", "11111111111111111111111111111111"],
        variables,
    )
    .output()
    .await
    .unwrap();
    assert_eq!(added.status.code(), Some(0), "{added:?}");
}

/// Every file of `folder` (not its subfolders) with its bytes.
fn folder_contents(folder: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<_> = std::fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.is_file())
        .map(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            (name, std::fs::read(&path).unwrap())
        })
        .collect();
    files.sort();
    files
}

/// `GET /api/v1/health` over a plain connection, the raw response as text.
async fn get_health(address: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream
        .write_all(b"GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}
