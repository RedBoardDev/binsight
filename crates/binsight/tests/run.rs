//! `binsight run` as a real process: exit codes and graceful shutdown.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests fail loudly"
)]

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

const PASSWORD: &str = "correct horse battery staple";

/// `binsight run` with a clean environment: a temporary home and only the given variables.
fn binsight_run(home: &Path, variables: &[(&str, &str)]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_binsight"));
    command
        .arg("run")
        .env_clear()
        .env("HOME", home)
        .envs(variables.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// The variables of a valid configuration listening on a free port.
fn valid_variables(data_dir: &Path) -> Vec<(&'static str, String)> {
    vec![
        ("BINSIGHT_PASSWORD", PASSWORD.to_owned()),
        ("BINSIGHT_HELIUS_API_KEY", "test-placeholder-key".to_owned()),
        ("BINSIGHT_DATA_DIR", data_dir.display().to_string()),
        ("BINSIGHT_BIND", "127.0.0.1:0".to_owned()),
    ]
}

fn as_pairs<'values>(
    variables: &'values [(&'static str, String)],
) -> Vec<(&'static str, &'values str)> {
    variables
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect()
}

/// A running server and the lines it writes to standard error.
struct Server {
    child: Child,
    lines: mpsc::UnboundedReceiver<String>,
}

impl Server {
    async fn start(home: &Path, variables: &[(&str, &str)]) -> Self {
        let mut child = binsight_run(home, variables).spawn().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (sender, lines) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = sender.send(line);
            }
        });
        let mut server = Self { child, lines };
        server.wait_for_line("listening on http://").await;
        server
    }

    /// Waits until a line containing `text` is written, and returns it.
    async fn wait_for_line(&mut self, text: &str) -> String {
        let deadline = Duration::from_secs(30);
        tokio::time::timeout(deadline, async {
            loop {
                let line = self.lines.recv().await.expect("the server stopped early");
                if line.contains(text) {
                    return line;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("the server never wrote {text:?}"))
    }

    async fn send_sigterm(&self) {
        let pid = self.child.id().unwrap().to_string();
        let status = Command::new("kill")
            .args(["-TERM", &pid])
            .status()
            .await
            .unwrap();
        assert!(status.success());
    }
}

#[tokio::test]
async fn exits_with_78_and_names_the_variable_when_the_password_is_missing() {
    let home = tempfile::tempdir().unwrap();
    let output = binsight_run(home.path(), &[("BINSIGHT_HELIUS_API_KEY", "x")])
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
    let output = binsight_run(home.path(), &variables)
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
    let variables = valid_variables(&home.path().join("data"));
    let first = Server::start(home.path(), &as_pairs(&variables)).await;

    let second = binsight_run(home.path(), &as_pairs(&variables))
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
    let variables = valid_variables(&home.path().join("data"));
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
