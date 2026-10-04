//! The privacy guard: no fixture may cite the owner's addresses or other private words.
//!
//! The patterns live outside the repository, in `<git common dir>/info/private-denylist`, one
//! extended regular expression per line, matched without regard to case: the same file and the
//! same matcher (`grep -i -E -f`) as the local pre-commit hook, so both guards always agree. A
//! missing file refuses everything (fail closed).
//!
//! Text matching alone would miss an address hidden in binary data (the base64 transaction, an
//! account's data, an event's base58 instruction data, a hexadecimal or decimal byte list in a
//! log), so every base58 address written in a line of the list (alone, or inside a pattern such
//! as `\bADDRESS\b` or `A|B`) is also searched as its 32 raw bytes in every
//! [`binary_forms`](super::binary_forms) of the fixture. A line with a long base58 word that is not
//! an address is searched as text only, and the capture summary counts it.
//!
//! The guard only knows what the list names. An address derived from the owner's wallet (its
//! token accounts, its position accounts) is not the wallet's address: list those too.
//!
//! This module only checks; it never prints a pattern or what matched it.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, bail};
use serde_json::Value;

use super::binary_forms::binary_forms;
use super::identifiers::AddressText;
use listed_addresses::{LineAddresses, addresses_in_line};

mod listed_addresses;

/// Where the denylist lives, relative to the git common directory.
const DENYLIST_PATH: &str = "info/private-denylist";

/// The exit code of `grep` when no line matched.
const GREP_NO_MATCH: i32 = 1;

/// The private patterns, and the addresses among them as raw bytes.
#[derive(Debug)]
pub(crate) struct Denylist {
    path: PathBuf,
    addresses: Vec<[u8; AddressText::BYTES]>,
    text_only_lines: usize,
}

impl Denylist {
    /// Reads the denylist of the repository the command runs in.
    pub(crate) fn of_repository() -> anyhow::Result<Self> {
        let common_directory = crate::git::common_directory()?;
        Self::read(&common_directory.join(DENYLIST_PATH))
    }

    /// Reads the denylist at `path`; a missing file is an error.
    pub(crate) fn read(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| {
            format!(
                "the private denylist {} cannot be read; fixtures are refused without it",
                path.display()
            )
        })?;
        let lines: Vec<LineAddresses> = text.lines().map(addresses_in_line).collect();
        let text_only_lines = lines
            .iter()
            .filter(|line| line.has_an_unreadable_word)
            .count();
        Ok(Self {
            path: path.to_owned(),
            addresses: lines.into_iter().flat_map(|line| line.addresses).collect(),
            text_only_lines,
        })
    }

    /// What the guard searches, in counts only (never a pattern), for the capture summary.
    pub(crate) fn coverage(&self) -> String {
        let coverage = format!(
            "the private denylist names {} address(es), searched as text and as bytes",
            self.addresses.len()
        );
        if self.text_only_lines == 0 {
            return coverage;
        }
        format!(
            "{coverage}; {} line(s) hold a long base58 word that is not an address, searched as \
             text only",
            self.text_only_lines
        )
    }

    /// Refuses the JSON answer `json` (named `label` in the error) if it cites anything on the
    /// list, as text or inside its binary data.
    pub(crate) fn check_json(&self, label: &str, json: &str) -> anyhow::Result<()> {
        self.check_text(label, json)?;
        if self.cites_an_address_in_binary(json)? {
            bail!(
                "{label} holds a denylisted address inside its binary data; pick another \
                 transaction or account"
            );
        }
        Ok(())
    }

    /// Refuses the plain `text` (named `label` in the error) if it matches a pattern of the list.
    pub(crate) fn check_text(&self, label: &str, text: &str) -> anyhow::Result<()> {
        if self.matches_as_text(text)? {
            bail!("{label} matches the private denylist; pick another transaction or account");
        }
        Ok(())
    }

    fn matches_as_text(&self, text: &str) -> anyhow::Result<bool> {
        let mut grep = Command::new("grep")
            .args(["-q", "-i", "-E", "-f"])
            .arg(&self.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("could not run grep to check the private denylist")?;
        // grep -q may exit at the first match, before reading everything: a broken pipe then
        // means a match, which the exit status reports.
        if let Some(mut input) = grep.stdin.take() {
            let _ = input.write_all(text.as_bytes());
        }
        let status = grep.wait().context("grep did not finish")?;
        match status.code() {
            Some(0) => Ok(true),
            Some(GREP_NO_MATCH) => Ok(false),
            _ => bail!("grep could not check the private denylist ({status})"),
        }
    }

    fn cites_an_address_in_binary(&self, json: &str) -> anyhow::Result<bool> {
        if self.addresses.is_empty() {
            return Ok(false);
        }
        let value: Value = serde_json::from_str(json).context("the fixture is not JSON")?;
        Ok(binary_forms(&value).iter().any(|bytes| {
            self.addresses
                .iter()
                .any(|address| contains(bytes, address))
        }))
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;

    use super::*;

    /// The bytes of the address standing in for a private one.
    const LISTED_BYTES: [u8; 32] = [7; 32];

    fn listed() -> String {
        bs58::encode(LISTED_BYTES).into_string()
    }

    fn denylist(lines: &str) -> (tempfile::TempDir, Denylist) {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("private-denylist");
        std::fs::write(&path, lines).unwrap();
        let list = Denylist::read(&path).unwrap();
        (folder, list)
    }

    #[test]
    fn refuses_a_fixture_that_cites_a_listed_address_as_text() {
        let (_folder, list) = denylist(&format!("{}\n", listed()));
        let json = format!(
            r#"{{"meta":{{"postTokenBalances":[{{"owner":"{}"}}]}}}}"#,
            listed()
        );
        assert!(list.check_json("tx-1.json", &json).is_err());
    }

    #[test]
    fn refuses_a_listed_address_hidden_in_the_base64_transaction() {
        let (_folder, list) = denylist(&format!("{}\n", listed()));
        let mut message = vec![1, 2, 3];
        message.extend(LISTED_BYTES);
        let json = format!(
            r#"{{"transaction":["{}","base64"]}}"#,
            STANDARD.encode(&message)
        );
        let error = list.check_json("tx-1.json", &json).unwrap_err();
        assert!(error.to_string().contains("binary data"), "{error}");
    }

    #[test]
    fn refuses_a_listed_address_hidden_in_base58_instruction_data() {
        let (_folder, list) = denylist(&format!("{}\n", listed()));
        let mut data = vec![0xe4, 0x45];
        data.extend(LISTED_BYTES);
        let json = format!(r#"{{"data":"{}"}}"#, bs58::encode(&data).into_string());
        assert!(list.check_json("tx-1.json", &json).is_err());
    }

    #[test]
    fn refuses_a_listed_address_hidden_in_a_base64_log_line() {
        let (_folder, list) = denylist(&format!("{}\n", listed()));
        let json = format!(
            r#"{{"meta":{{"logMessages":["Program data: {}"]}}}}"#,
            STANDARD.encode(LISTED_BYTES)
        );
        assert!(list.check_json("tx-1.json", &json).is_err());
    }

    #[test]
    fn refuses_text_that_matches_a_pattern_whatever_its_case() {
        let (_folder, list) = denylist("secret[- ]project\n");
        assert!(
            list.check_text("case.toml", "why = \"the SECRET project\"")
                .is_err()
        );
    }

    #[test]
    fn accepts_a_fixture_that_cites_nothing_listed() {
        let (_folder, list) = denylist(&format!("{}\nsecret-project\n", listed()));
        let json = format!(
            r#"{{"transaction":["{}","base64"]}}"#,
            STANDARD.encode([9; 64])
        );
        assert!(list.check_json("tx-1.json", &json).is_ok());
    }

    #[test]
    fn refuses_everything_without_a_denylist() {
        let folder = tempfile::tempdir().unwrap();
        assert!(Denylist::read(&folder.path().join("missing")).is_err());
    }

    #[test]
    fn searches_an_address_written_inside_a_pattern_as_bytes() {
        let other = bs58::encode([8; 32]).into_string();
        for line in [
            format!("\\b{}\\b", listed()),
            format!("^{other}$|({})", listed()),
        ] {
            let (_folder, list) = denylist(&format!("{line}\n"));
            let json = format!(
                r#"{{"transaction":["{}","base64"]}}"#,
                STANDARD.encode(LISTED_BYTES)
            );
            assert!(list.check_json("tx-1.json", &json).is_err(), "{line}");
        }
    }

    #[test]
    fn counts_the_addresses_and_the_lines_searched_as_text_only() {
        let not_an_address = "z".repeat(40);
        let (_folder, list) = denylist(&format!("{}\n{not_an_address}\nshort\n", listed()));
        let coverage = list.coverage();
        assert!(coverage.contains("names 1 address(es)"), "{coverage}");
        assert!(coverage.contains("1 line(s)"), "{coverage}");
        assert!(!coverage.contains(&listed()), "{coverage}");
    }
}
