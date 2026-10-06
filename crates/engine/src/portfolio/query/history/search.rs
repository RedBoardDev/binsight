//! The History search: one text matched against a position's pair, tokens, pool and id.
//!
//! A symbol matches by prefix, ignoring case (`bon` finds BONK); `BONK/SOL` matches the pair, each
//! side by prefix; a name matches anywhere in it, ignoring case; a mint, a pool address or a
//! position address (or id) matches by prefix, exactly as written, from four characters on.

use binsight_ledger::facts::{PoolFacts, PositionId, TokenFacts};

use crate::portfolio::query::refs::display_tokens;

/// The longest search text, in characters.
pub const MAX_SEARCH_CHARS: usize = 64;

/// The shortest prefix of an address or an id that is searched for.
const MIN_ADDRESS_PREFIX_CHARS: usize = 4;

/// A search text: trimmed, from 1 to [`MAX_SEARCH_CHARS`] characters.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SearchText {
    exact: String,
    folded: String,
}

/// A search text is empty or too long.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("a search text has 1 to {MAX_SEARCH_CHARS} characters")]
pub struct SearchTextError;

impl SearchText {
    /// Reads a search text.
    ///
    /// # Errors
    ///
    /// Returns [`SearchTextError`] when it is empty once trimmed, or longer than
    /// [`MAX_SEARCH_CHARS`] characters.
    pub fn parse(text: &str) -> Result<Self, SearchTextError> {
        let exact = text.trim();
        let length = exact.chars().count();
        if length == 0 || length > MAX_SEARCH_CHARS {
            return Err(SearchTextError);
        }
        Ok(Self {
            exact: exact.to_owned(),
            folded: exact.to_lowercase(),
        })
    }

    /// The text as written, once trimmed.
    pub fn as_str(&self) -> &str {
        &self.exact
    }

    /// Whether the text names the pool: its pair, one of its tokens, or its address.
    pub fn matches_pool(&self, pool: &PoolFacts) -> bool {
        self.matches_pair(pool)
            || [&pool.base, &pool.quote]
                .iter()
                .any(|token| self.matches_token(token))
            || (self.has_identifier_prefix() && self.is_prefix_of(&pool.address.to_string()))
    }

    /// Whether the text names the position (by address or id) or its pool.
    pub fn matches_position(&self, id: PositionId, pool: &PoolFacts) -> bool {
        self.matches_pool(pool)
            || (self.has_identifier_prefix() && self.is_prefix_of(&id.to_string()))
    }

    /// Whether the text is the exact symbol of one of the pool's tokens, ignoring case.
    pub fn is_symbol_of(&self, pool: &PoolFacts) -> bool {
        [&pool.base, &pool.quote].iter().any(|token| {
            token
                .symbol
                .as_ref()
                .is_some_and(|symbol| symbol.to_lowercase() == self.folded)
        })
    }

    /// Whether the text is `BASE/QUOTE` for the pool, each side by prefix.
    fn matches_pair(&self, pool: &PoolFacts) -> bool {
        let Some((base, quote)) = self.folded.split_once('/') else {
            return false;
        };
        let starts = |token: &TokenFacts, prefix: &str| {
            token
                .symbol
                .as_ref()
                .is_some_and(|symbol| symbol.to_lowercase().starts_with(prefix.trim()))
        };
        let (base_token, quote_token) = display_tokens(pool);
        starts(base_token, base) && starts(quote_token, quote)
    }

    /// Whether the text names the token: its symbol by prefix, its name anywhere, or its mint.
    fn matches_token(&self, token: &TokenFacts) -> bool {
        let symbol = token
            .symbol
            .as_ref()
            .is_some_and(|symbol| symbol.to_lowercase().starts_with(&self.folded));
        let name = token
            .name
            .as_ref()
            .is_some_and(|name| name.to_lowercase().contains(&self.folded));
        symbol
            || name
            || (self.has_identifier_prefix() && self.is_prefix_of(&token.mint.to_string()))
    }

    /// Check before encoding an address: short symbol searches cannot match identifiers.
    fn has_identifier_prefix(&self) -> bool {
        self.exact.chars().count() >= MIN_ADDRESS_PREFIX_CHARS
    }

    /// Whether the written prefix names an identifier.
    fn is_prefix_of(&self, identifier: &str) -> bool {
        identifier.starts_with(&self.exact)
    }
}

#[cfg(test)]
mod tests {
    use binsight_core::units::Decimals;
    use binsight_ledger::facts::TokenKind;
    use binsight_solana::Address;

    use super::*;

    fn token(symbol: &str, name: &str, byte: u8) -> TokenFacts {
        TokenFacts {
            mint: Address::from_bytes([byte; 32]),
            symbol: Some(symbol.to_owned()),
            name: Some(name.to_owned()),
            decimals: Decimals(6),
            kind: TokenKind::Other,
        }
    }

    fn pool() -> PoolFacts {
        PoolFacts {
            address: Address::from_bytes([9; 32]),
            bin_step: 80,
            base: token("BONK", "Bonk", 1),
            quote: token("SOL", "Wrapped SOL", 2),
        }
    }

    fn prefix(text: &str, length: usize) -> String {
        text.chars().take(length).collect()
    }

    fn search(text: &str) -> SearchText {
        SearchText::parse(text).unwrap()
    }

    #[test]
    fn finds_a_pool_by_symbol_prefix_pair_name_or_address() {
        let pool = pool();
        let address = pool.address.to_string();

        assert!(search("bon").matches_pool(&pool));
        assert!(search("BONK/SOL").matches_pool(&pool));
        assert!(search("bonk / s").matches_pool(&pool));
        assert!(search("wrapped").matches_pool(&pool));
        assert!(search(&prefix(&address, 6)).matches_pool(&pool));
        assert!(!search("JUP").matches_pool(&pool));
        assert!(!search("SOL/BONK").matches_pool(&pool));
    }

    #[test]
    fn needs_four_characters_to_search_an_address() {
        let pool = pool();
        let address = pool.address.to_string();

        assert!(!search(&prefix(&address, 3)).matches_pool(&pool));
    }

    #[test]
    fn refuses_an_empty_or_too_long_text() {
        assert_eq!(SearchText::parse("   "), Err(SearchTextError));
        assert_eq!(SearchText::parse(&"x".repeat(65)), Err(SearchTextError));
        assert_eq!(search("  bonk ").as_str(), "bonk");
    }
}
