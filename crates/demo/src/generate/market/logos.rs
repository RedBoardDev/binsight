//! The token logos of the demo world: small abstract images, one per busy token.
//!
//! They are drawn for the demo (a coloured disc with a pattern) and resemble no real brand.
//! SOL needs none (clients draw its coin) and the long-tail tokens have none (clients draw a
//! monogram), as in a real instance.

use std::sync::Arc;

use binsight_engine::portfolio::TokenLogoFacts;
use binsight_engine::portfolio::views::TokenLogoImage;
use sha2::{Digest, Sha256};

use super::catalog::Catalog;

/// The logo of each busy token, by ticker.
const LOGOS: [(&str, &[u8]); 6] = [
    ("JUP", include_bytes!("../../../assets/logos/jup.png")),
    ("JTO", include_bytes!("../../../assets/logos/jto.png")),
    ("WIF", include_bytes!("../../../assets/logos/wif.png")),
    ("POPCAT", include_bytes!("../../../assets/logos/popcat.png")),
    ("BONK", include_bytes!("../../../assets/logos/bonk.png")),
    ("USDC", include_bytes!("../../../assets/logos/usdc.png")),
];

/// How many bytes of the image hash version its URL (two hex digits each).
const VERSION_BYTES: usize = 6;

/// The logos of the catalog's tokens that have one.
pub(crate) fn token_logos(catalog: &Catalog) -> Vec<TokenLogoFacts> {
    let mut logos: Vec<TokenLogoFacts> = Vec::new();
    for token in catalog
        .pools
        .iter()
        .flat_map(|pool| [&pool.facts.base, &pool.facts.quote])
    {
        let image = LOGOS
            .iter()
            .find(|(symbol, _)| token.symbol.as_deref() == Some(*symbol));
        let is_known = logos.iter().any(|logo| logo.mint == token.mint);
        if let Some((_, bytes)) = image.filter(|_| !is_known) {
            logos.push(TokenLogoFacts {
                mint: token.mint,
                image: TokenLogoImage {
                    content_type: "image/png",
                    bytes: Arc::from(*bytes),
                },
                version: fingerprint(bytes),
            });
        }
    }
    logos
}

/// The first hex digits of the SHA-256 of `bytes`.
fn fingerprint(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(VERSION_BYTES)
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .filter_map(|digit| char::from_digit(u32::from(digit), 16))
        .collect()
}
