//! The `case.toml` file that describes a mainnet fixture case.
//!
//! It says why the case exists, whose point of view its tests take, which rules it illustrates,
//! and which file holds which transaction or account. This module only renders the file; it does
//! not write it.

use serde::Serialize;

/// The first lines of every `case.toml`.
const HEADER: &str = "# Captured by `cargo xtask fixture capture` (finalized commitment). Each JSON \
                      file is the\n# node's `result`, byte for byte; do not edit them by hand.\n\n";

/// The content of a `case.toml`.
#[derive(Debug, Serialize)]
pub(crate) struct CaseFile {
    /// The case name (its folder).
    pub(crate) name: String,
    /// One sentence saying what the case shows.
    pub(crate) why: String,
    /// The public wallet whose point of view the tests take.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) perspective: Option<String>,
    /// The rule and oracle identifiers the case illustrates.
    pub(crate) oracles: Vec<String>,
    /// The day of the capture (UTC), `YYYY-MM-DD`.
    pub(crate) captured_at: String,
    /// The transactions, in the order they happened.
    #[serde(rename = "transaction")]
    pub(crate) transactions: Vec<CapturedTransaction>,
    /// The account snapshots.
    #[serde(rename = "account", skip_serializing_if = "Vec::is_empty")]
    pub(crate) accounts: Vec<CapturedAccount>,
}

/// One transaction of a case.
#[derive(Debug, Serialize)]
pub(crate) struct CapturedTransaction {
    /// The file, relative to the case folder.
    pub(crate) file: String,
    /// The transaction signature.
    pub(crate) signature: String,
    /// The slot it landed in.
    pub(crate) slot: u64,
}

/// One account snapshot of a case.
#[derive(Debug, Serialize)]
pub(crate) struct CapturedAccount {
    /// The file, relative to the case folder.
    pub(crate) file: String,
    /// The account address.
    pub(crate) address: String,
    /// The slot the snapshot was taken at.
    pub(crate) slot: u64,
}

impl CaseFile {
    /// The text of the file.
    pub(crate) fn render(&self) -> anyhow::Result<String> {
        Ok(format!("{HEADER}{}", toml::to_string(self)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_one_table_per_transaction_after_the_description() {
        let case = CaseFile {
            name: "legacy-sol-transfer".to_owned(),
            why: "a direct SOL transfer".to_owned(),
            perspective: None,
            oracles: vec!["L-2".to_owned()],
            captured_at: "2026-10-04".to_owned(),
            transactions: vec![CapturedTransaction {
                file: "tx-1.json".to_owned(),
                signature: "sig".to_owned(),
                slot: 7,
            }],
            accounts: Vec::new(),
        };
        let text = case.render().unwrap();
        assert!(text.starts_with("# Captured by"));
        assert!(text.contains("name = \"legacy-sol-transfer\"\n"));
        assert!(text.contains("[[transaction]]\nfile = \"tx-1.json\"\n"));
        assert!(!text.contains("[[account]]"));
    }
}
