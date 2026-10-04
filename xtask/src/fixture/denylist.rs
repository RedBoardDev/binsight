//! The privacy guard: no fixture may cite the owner's addresses or other private words.
//!
//! The patterns live outside the repository, in `<git common dir>/info/private-denylist`, one
//! extended regular expression per line, matched without regard to case: the same file and the
//! same matcher (`grep -i -E -f`) as the local pre-commit hook, so both guards always agree. A
//! missing file refuses everything (fail closed).
//!
//! Text matching alone would miss an address hidden in binary data (the base64 transaction, an
//! account's data, an event's base58 instruction data), so every pattern that is a base58 address
//! is also searched as its 32 raw bytes inside every word of every string of the fixture that
//! decodes as base64 or base58 (a log line such as `Program data: <base64>` included). This module only checks; it never prints a pattern or what matched it.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use super::identifiers::AddressText;

/// Where the denylist lives, relative to the git common directory.
const DENYLIST_PATH: &str = "info/private-denylist";

/// The exit code of `grep` when no line matched.
const GREP_NO_MATCH: i32 = 1;

/// The private patterns, and the addresses among them as raw bytes.
#[derive(Debug)]
pub(crate) struct Denylist {
    path: PathBuf,
    addresses: Vec<[u8; AddressText::BYTES]>,
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
        let addresses = text.lines().filter_map(address_bytes).collect();
        Ok(Self {
            path: path.to_owned(),
            addresses,
        })
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
        let mut strings = Vec::new();
        collect_strings(&value, &mut strings);
        Ok(strings.iter().any(|text| {
            decodings(text).iter().any(|bytes| {
                self.addresses
                    .iter()
                    .any(|address| contains(bytes, address))
            })
        }))
    }
}

/// The 32 bytes of a denylist line that is a whole base58 address.
fn address_bytes(line: &str) -> Option<[u8; AddressText::BYTES]> {
    let bytes = bs58::decode(line.trim()).into_vec().ok()?;
    bytes.try_into().ok()
}

fn collect_strings<'a>(value: &'a Value, strings: &mut Vec<&'a str>) {
    match value {
        Value::String(text) => strings.push(text),
        Value::Array(items) => items.iter().for_each(|item| collect_strings(item, strings)),
        Value::Object(fields) => fields
            .values()
            .for_each(|item| collect_strings(item, strings)),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// The bytes each word of `text` stands for, if it is base64 or base58.
fn decodings(text: &str) -> Vec<Vec<u8>> {
    text.split_whitespace()
        .flat_map(|word| {
            [
                STANDARD.decode(word).ok(),
                bs58::decode(word).into_vec().ok(),
            ]
        })
        .flatten()
        .collect()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[cfg(test)]
mod tests {
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
}
