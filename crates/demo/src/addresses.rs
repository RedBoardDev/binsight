//! Fake but valid Solana identifiers for the demo world.
//!
//! Every address and signature is the SHA-256 of a label (`binsight-demo:` + what it names), so it
//! is a well-formed 32- or 64-byte value that belongs to nobody: links to explorers lead to empty
//! pages, and no real wallet, token or pool ever enters the demo.

use binsight_solana::{Address, Signature};
use sha2::{Digest, Sha256};

/// The prefix of every label, so demo identifiers never collide with anything meaningful.
const LABEL_PREFIX: &str = "binsight-demo:";

/// The fake address named `label`.
pub(crate) fn address(label: &str) -> Address {
    Address::from_bytes(digest(label, 0))
}

/// The fake transaction signature named `label`.
pub(crate) fn signature(label: &str) -> Signature {
    let (first, second) = (digest(label, 1), digest(label, 2));
    let mut bytes = [0_u8; 64];
    for (byte, source) in bytes.iter_mut().zip(first.iter().chain(second.iter())) {
        *byte = *source;
    }
    Signature::from_bytes(bytes)
}

/// The SHA-256 of the prefixed `label` and a part number.
fn digest(label: &str, part: u8) -> [u8; 32] {
    Sha256::new()
        .chain_update(LABEL_PREFIX)
        .chain_update(label)
        .chain_update([part])
        .finalize()
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_same_identifier_from_the_same_label() {
        assert_eq!(address("wallet:Main"), address("wallet:Main"));
        assert_ne!(address("wallet:Main"), address("wallet:Degen"));
        assert_ne!(signature("open:1"), signature("open:2"));
    }

    #[test]
    fn writes_identifiers_that_read_back() {
        let written = address("pool:JUP/SOL").to_string();
        assert_eq!(written.parse::<Address>(), Ok(address("pool:JUP/SOL")));
        let written = signature("open:1").to_string();
        assert_eq!(written.parse::<Signature>(), Ok(signature("open:1")));
    }
}
