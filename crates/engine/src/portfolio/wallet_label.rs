//! The label of a tracked wallet: short, readable, unique, and never empty.
//!
//! The rule lives here once for every client that adds a wallet (the web app, the command line,
//! later the macOS app): the text is trimmed; an empty label becomes the wallet's short address
//! (`AbCd…wXyZ`); a label has at most ten characters (the length of a short address, so it fits
//! the wallet picker and the share card); control and bidirectional-override characters are
//! refused. Uniqueness is checked by whoever holds the list of wallets.

use std::fmt;

use binsight_solana::Address;

/// The longest label, in Unicode characters.
pub const MAX_WALLET_LABEL_CHARS: usize = 10;

/// How many characters of the address the short form keeps on each side.
const SHORT_ADDRESS_SIDE_CHARS: usize = 4;

/// The label of a tracked wallet.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WalletLabel(String);

/// A label was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum WalletLabelError {
    /// The label is longer than [`MAX_WALLET_LABEL_CHARS`].
    #[error("a wallet label has at most {MAX_WALLET_LABEL_CHARS} characters")]
    TooLong,
    /// The label contains a control or bidirectional-formatting character.
    #[error("a wallet label may not contain control or text-direction characters")]
    InvalidCharacter,
}

impl WalletLabel {
    /// The label the owner typed for `address`; a missing or blank one becomes the short address.
    ///
    /// # Errors
    ///
    /// Returns [`WalletLabelError`] when the text is too long or contains a forbidden character.
    pub fn parse(text: Option<&str>, address: &Address) -> Result<Self, WalletLabelError> {
        let trimmed = text.map(str::trim).unwrap_or_default();
        if trimmed.is_empty() {
            return Ok(Self::short_address(address));
        }
        if trimmed.chars().any(is_forbidden) {
            return Err(WalletLabelError::InvalidCharacter);
        }
        if trimmed.chars().count() > MAX_WALLET_LABEL_CHARS {
            return Err(WalletLabelError::TooLong);
        }
        Ok(Self(trimmed.to_owned()))
    }

    /// The short form of `address`: its first and last four characters around an ellipsis.
    pub fn short_address(address: &Address) -> Self {
        let text = address.to_string();
        let head: String = text.chars().take(SHORT_ADDRESS_SIDE_CHARS).collect();
        let tail_start = text
            .chars()
            .count()
            .saturating_sub(SHORT_ADDRESS_SIDE_CHARS);
        let tail: String = text.chars().skip(tail_start).collect();
        Self(format!("{head}…{tail}"))
    }

    /// The label as text.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether two labels are the same when case is ignored (labels must differ that way).
    pub fn is_same_as(&self, other: &Self) -> bool {
        self.0.to_lowercase() == other.0.to_lowercase()
    }
}

impl fmt::Display for WalletLabel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Control characters and the characters that change the direction of text (which could make a
/// label display as something else).
fn is_forbidden(character: char) -> bool {
    const BIDI_FORMATTING: [char; 12] = [
        '\u{061C}', '\u{200E}', '\u{200F}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}',
        '\u{202E}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}',
    ];
    character.is_control() || BIDI_FORMATTING.contains(&character)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address() -> Address {
        Address::from_bytes([7; 32])
    }

    #[test]
    fn falls_back_to_the_short_address_when_blank() {
        let text = address().to_string();
        let (head, tail) = (text.get(..4).unwrap(), text.get(text.len() - 4..).unwrap());
        let expected = format!("{head}…{tail}");
        let expected = expected.as_str();
        assert_eq!(
            WalletLabel::parse(None, &address()).unwrap().as_str(),
            expected
        );
        assert_eq!(
            WalletLabel::parse(Some("   "), &address())
                .unwrap()
                .as_str(),
            expected
        );
        assert_eq!(expected.chars().count(), 9);
    }

    #[test]
    fn trims_and_keeps_a_label_of_ten_characters() {
        let label = WalletLabel::parse(Some("  Main café "), &address()).unwrap();
        assert_eq!(label.as_str(), "Main café");
        assert!(WalletLabel::parse(Some("0123456789"), &address()).is_ok());
    }

    #[test]
    fn refuses_eleven_characters() {
        assert_eq!(
            WalletLabel::parse(Some("01234567890"), &address()),
            Err(WalletLabelError::TooLong)
        );
    }

    #[test]
    fn refuses_control_and_direction_characters() {
        for text in ["a\u{7}b", "abc\u{202E}d", "line\nbreak"] {
            assert_eq!(
                WalletLabel::parse(Some(text), &address()),
                Err(WalletLabelError::InvalidCharacter)
            );
        }
    }

    #[test]
    fn compares_labels_without_case() {
        let main = WalletLabel::parse(Some("Main"), &address()).unwrap();
        let shout = WalletLabel::parse(Some("MAIN"), &address()).unwrap();
        assert!(main.is_same_as(&shout));
    }
}
