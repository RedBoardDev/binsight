//! Shared helpers for the tests that drive the real `binsight` executable.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers fail loudly; each test binary uses a different part"
)]

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// The owner's password in tests.
pub(crate) const PASSWORD: &str = "correct horse battery staple";

/// `binsight <arguments>` with a clean environment: a temporary home and only `variables`.
pub(crate) fn binsight(home: &Path, arguments: &[&str], variables: &[(&str, &str)]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_binsight"));
    command
        .args(arguments)
        .env_clear()
        .env("HOME", home)
        .envs(variables.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// The variables of a valid configuration whose data folder is in `home`, listening on `bind`.
pub(crate) fn valid_variables(home: &Path, bind: &str) -> Vec<(&'static str, String)> {
    vec![
        ("BINSIGHT_PASSWORD", PASSWORD.to_owned()),
        ("BINSIGHT_HELIUS_API_KEY", "test-placeholder-key".to_owned()),
        ("BINSIGHT_DATA_DIR", home.join("data").display().to_string()),
        ("BINSIGHT_BIND", bind.to_owned()),
    ]
}

/// Borrows owned variables as the pairs [`binsight`] takes.
pub(crate) fn as_pairs<'values>(
    variables: &'values [(&'static str, String)],
) -> Vec<(&'static str, &'values str)> {
    variables
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect()
}

/// A running `binsight run` and the lines it writes to standard error.
pub(crate) struct Server {
    pub(crate) child: Child,
    /// The address it listens on.
    pub(crate) address: String,
    lines: mpsc::UnboundedReceiver<String>,
}

impl Server {
    /// Starts `binsight run` and waits until it listens.
    pub(crate) async fn start(home: &Path, variables: &[(&str, &str)]) -> Self {
        let mut child = binsight(home, &["run"], variables).spawn().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (sender, lines) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = sender.send(line);
            }
        });
        let mut server = Self {
            child,
            address: String::new(),
            lines,
        };
        let listening = server.wait_for_line("listening url=http://").await;
        listening
            .rsplit("url=http://")
            .next()
            .unwrap()
            .trim()
            .clone_into(&mut server.address);
        server
    }

    /// Waits until a line containing `text` is written, and returns it.
    pub(crate) async fn wait_for_line(&mut self, text: &str) -> String {
        tokio::time::timeout(Duration::from_secs(30), async {
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

    /// Sends SIGTERM, as `docker stop` does.
    pub(crate) async fn send_sigterm(&self) {
        let pid = self.child.id().unwrap().to_string();
        let status = Command::new("kill")
            .args(["-TERM", &pid])
            .status()
            .await
            .unwrap();
        assert!(status.success());
    }
}
