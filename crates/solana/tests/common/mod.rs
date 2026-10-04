//! Shared helpers for the tests that read the mainnet fixtures of `tests/fixtures/mainnet`.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "test helpers fail loudly; each test binary uses a different part"
)]

use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use binsight_solana::Address;
use serde::Deserialize;

/// A fixture case, as its `case.toml` describes it.
#[derive(Debug, Deserialize)]
pub(crate) struct Case {
    /// The case name (its folder).
    pub(crate) name: String,
    /// The public wallet whose point of view the tests take.
    pub(crate) perspective: Option<String>,
    /// The transactions, in order.
    #[serde(rename = "transaction")]
    pub(crate) transactions: Vec<CaseTransaction>,
}

/// One transaction of a case.
#[derive(Debug, Deserialize)]
pub(crate) struct CaseTransaction {
    /// The JSON file, relative to the case folder.
    pub(crate) file: String,
    /// Its signature.
    pub(crate) signature: String,
    /// Its slot.
    pub(crate) slot: u64,
}

/// The folder of every mainnet case.
pub(crate) fn mainnet_fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mainnet")
}

/// The case named `name`.
pub(crate) fn case(name: &str) -> Case {
    let path = mainnet_fixtures().join(name).join("case.toml");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("cannot read {}: {error}", path.display());
    });
    toml::from_str(&text).unwrap()
}

/// Every case, sorted by name.
pub(crate) fn all_cases() -> Vec<Case> {
    let mut names: Vec<String> = std::fs::read_dir(mainnet_fixtures())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names.iter().map(|name| case(name)).collect()
}

impl Case {
    /// The `getTransaction` result of the transaction at `position` (from 0).
    pub(crate) fn transaction_json(&self, position: usize) -> Vec<u8> {
        let file = &self.transactions[position].file;
        std::fs::read(mainnet_fixtures().join(&self.name).join(file)).unwrap()
    }
}

/// The address written `text` in base58.
pub(crate) fn address(text: &str) -> Address {
    text.parse().unwrap()
}

/// The bytes of base64 `text`.
pub(crate) fn base64_decode(text: &str) -> Vec<u8> {
    STANDARD.decode(text).unwrap()
}

/// `bytes` in base64.
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}
