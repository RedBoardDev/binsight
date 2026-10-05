//! The names and on-chain identifiers a fixture command accepts, checked once when parsed.
//!
//! A case name and an RPC method become folder and file names, and signatures and addresses are
//! sent to the node, so each is refused unless it has the exact expected shape. This module only
//! parses; it does not touch the disk or the network.

use std::fmt;

use anyhow::{bail, ensure};

/// The name of a fixture case, which is also its folder: lowercase words joined by hyphens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CaseName(String);

impl CaseName {
    /// Parses a name such as `v0-add-liquidity-alt`.
    pub(crate) fn parse(text: &str) -> anyhow::Result<Self> {
        let is_word = |word: &str| {
            !word.is_empty()
                && word
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        };
        ensure!(
            text.split('-').all(is_word),
            "the case name `{text}` must be lowercase words and digits joined by hyphens"
        );
        Ok(Self(text.to_owned()))
    }

    /// The name as text.
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// A JSON-RPC method name: an ASCII letter followed by ASCII letters or digits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RpcMethod(String);

impl RpcMethod {
    /// Parses a method name.
    pub(crate) fn parse(text: &str) -> anyhow::Result<Self> {
        ensure!(
            text.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && text
                    .bytes()
                    .all(|character| character.is_ascii_alphanumeric()),
            "the RPC method `{text}` must start with an ASCII letter and contain only ASCII letters or digits"
        );
        Ok(Self(text.to_owned()))
    }

    /// The name as text.
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// A transaction signature in base58 (64 bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SignatureText(String);

impl SignatureText {
    /// The number of bytes of a signature.
    const BYTES: usize = 64;

    /// Parses base58 text that decodes to 64 bytes.
    pub(crate) fn parse(text: &str) -> anyhow::Result<Self> {
        check_base58_length(text, Self::BYTES, "signature")?;
        Ok(Self(text.to_owned()))
    }

    /// The signature as base58 text.
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// An account address in base58 (32 bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AddressText(String);

impl AddressText {
    /// The number of bytes of an address.
    pub(crate) const BYTES: usize = 32;

    /// Parses base58 text that decodes to 32 bytes.
    pub(crate) fn parse(text: &str) -> anyhow::Result<Self> {
        check_base58_length(text, Self::BYTES, "address")?;
        Ok(Self(text.to_owned()))
    }

    /// The address as base58 text.
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AddressText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Checks that `text` is base58 for exactly `bytes` bytes.
fn check_base58_length(text: &str, bytes: usize, what: &str) -> anyhow::Result<()> {
    let Ok(decoded) = bs58::decode(text).into_vec() else {
        bail!("the {what} `{text}` is not base58");
    };
    ensure!(
        decoded.len() == bytes,
        "the {what} `{text}` decodes to {} bytes instead of {bytes}",
        decoded.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_hyphenated_lowercase_case_names_only() {
        assert!(CaseName::parse("v0-add-liquidity-alt").is_ok());
        for refused in [
            "",
            "Upper",
            "two--hyphens",
            "-leading",
            "dots.dots",
            "../escape",
        ] {
            assert!(CaseName::parse(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn accepts_standard_and_versioned_rpc_method_names() {
        for accepted in [
            "getSignaturesForAddress",
            "getProgramAccountsV2",
            "getTokenAccountsByOwnerV2",
        ] {
            assert!(RpcMethod::parse(accepted).is_ok(), "{accepted}");
        }
    }

    #[test]
    fn refuses_rpc_names_that_are_paths_or_not_ascii_identifiers() {
        for refused in [
            "",
            "2get",
            "get/../Transaction",
            "../V2",
            "getV2/escape",
            "get.V2",
            "get V2",
            "gétProgramAccounts",
            "getProgramAccountsV₂",
        ] {
            assert!(RpcMethod::parse(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn tells_addresses_and_signatures_apart_by_their_length() {
        let address = "11111111111111111111111111111111";
        let signature = "1".repeat(64);
        assert!(AddressText::parse(address).is_ok());
        assert!(SignatureText::parse(address).is_err());
        assert!(SignatureText::parse(&signature).is_ok());
        assert!(AddressText::parse(&signature).is_err());
        assert!(AddressText::parse("0OIl").is_err());
    }
}
