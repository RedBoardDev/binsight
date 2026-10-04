//! The market of the demo world: its tokens and pools, their logos, the SOL/USD rate and the
//! price path of every pool, all made of exact bin prices.

mod bins;
mod catalog;
mod logos;
mod price_path;
mod rates;

pub(crate) use bins::bin_price;
pub(crate) use catalog::{Catalog, CatalogPool, catalog};
pub(crate) use logos::token_logos;
pub(crate) use price_path::{PricePath, following_rates, minute_start, random_walk};
pub(crate) use rates::sol_usd_rates;
