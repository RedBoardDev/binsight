//! `binsight init` as a real process: it never overwrites a file and needs a terminal.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

use std::path::Path;
use std::process::{Output, Stdio};

use tokio::process::Command;

async fn binsight_init(home: &Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_binsight"))
        .arg("init")
        .args(arguments)
        .env_clear()
        .env("HOME", home)
        .stdin(Stdio::null())
        .output()
        .await
        .unwrap()
}

#[tokio::test]
async fn refuses_to_ask_for_secrets_without_a_terminal() {
    let home = tempfile::tempdir().unwrap();

    let output = binsight_init(home.path(), &[]).await;

    assert_eq!(output.status.code(), Some(64));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("set BINSIGHT_PASSWORD and BINSIGHT_HELIUS_API_KEY"),
        "{stderr}"
    );
    assert!(!home.path().join(".config/binsight/binsight.env").exists());
}

#[tokio::test]
async fn never_overwrites_an_existing_file_without_force() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("custom.env");
    std::fs::write(&path, "BINSIGHT_BIND=127.0.0.1:9000\n").unwrap();

    let output = binsight_init(home.path(), &["--config-file", path.to_str().unwrap()]).await;

    assert_eq!(output.status.code(), Some(64));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("already exists"), "{stderr}");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "BINSIGHT_BIND=127.0.0.1:9000\n"
    );
}
