//! The command line help, pinned by snapshots: a change to it is reviewed like code.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod common;

use common::binsight;

async fn help_of(arguments: &[&str]) -> String {
    let home = tempfile::tempdir().unwrap();
    let output = binsight(home.path(), arguments, &[])
        .output()
        .await
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    String::from_utf8(output.stdout).unwrap()
}

#[tokio::test]
async fn lists_the_commands() {
    insta::assert_snapshot!("binsight_help", help_of(&["--help"]).await);
}

#[tokio::test]
async fn lists_the_admin_tasks() {
    insta::assert_snapshot!("binsight_admin_help", help_of(&["admin", "--help"]).await);
}

#[tokio::test]
async fn prints_the_version() {
    let version = help_of(&["--version"]).await;
    assert_eq!(version, format!("binsight {}\n", env!("CARGO_PKG_VERSION")));
}
