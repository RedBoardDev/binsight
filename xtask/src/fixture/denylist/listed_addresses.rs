//! The addresses a line of the private denylist names, to search them as bytes too.
//!
//! A line is an extended regular expression, so an address may stand alone (`ADDRESS`) or inside
//! a pattern (`\bADDRESS\b`, `^A$|B`). This module finds the base58 words of a line that decode
//! to 32 bytes; it does not match anything.

use crate::fixture::identifiers::AddressText;

/// The shortest and longest base58 text of 32 bytes.
const ADDRESS_TEXT_LENGTHS: std::ops::RangeInclusive<usize> = 32..=44;

/// The base58 alphabet, which has no `0`, `O`, `I` or `l`.
const BASE58_ALPHABET: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// The addresses one line of the list names.
pub(super) struct LineAddresses {
    /// The addresses, as raw bytes.
    pub(super) addresses: Vec<[u8; AddressText::BYTES]>,
    /// Whether the line has a word as long as an address that does not decode to one.
    pub(super) has_an_unreadable_word: bool,
}

/// The base58 addresses written in a line of the list, alone or inside a pattern.
///
/// A regular-expression escape (`\b`, `\<`) is not part of a word, and a base58 word ends at
/// the first character outside the base58 alphabet (`|`, `^`, `(`, a space…).
pub(super) fn addresses_in_line(line: &str) -> LineAddresses {
    let mut unescaped = String::with_capacity(line.len());
    let mut characters = line.chars();
    while let Some(character) = characters.next() {
        if character == '\\' {
            characters.next();
            unescaped.push(' ');
        } else {
            unescaped.push(character);
        }
    }
    let long_words: Vec<&str> = unescaped
        .split(|character: char| !BASE58_ALPHABET.contains(character))
        .filter(|word| ADDRESS_TEXT_LENGTHS.contains(&word.len()))
        .collect();
    let addresses: Vec<[u8; AddressText::BYTES]> = long_words
        .iter()
        .filter_map(|word| bs58::decode(word).into_vec().ok()?.try_into().ok())
        .collect();
    LineAddresses {
        has_an_unreadable_word: addresses.len() < long_words.len(),
        addresses,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_an_address_alone_or_inside_a_pattern() {
        let address = bs58::encode([7; 32]).into_string();
        for line in [
            address.clone(),
            format!("\\b{address}\\b"),
            format!("^secret$|({address})"),
        ] {
            let found = addresses_in_line(&line);
            assert_eq!(found.addresses, [[7; 32]], "{line}");
            assert!(!found.has_an_unreadable_word, "{line}");
        }
    }

    #[test]
    fn flags_a_word_as_long_as_an_address_that_is_not_one() {
        let found = addresses_in_line(&"z".repeat(40));
        assert_eq!(found.addresses.len(), 0);
        assert!(found.has_an_unreadable_word);
        assert!(!addresses_in_line("secret-project").has_an_unreadable_word);
    }
}
