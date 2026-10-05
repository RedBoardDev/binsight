//! An explicit, versioned digest of every effective day rate of the matching History list.

use binsight_ledger::facts::DailyRate;
use jiff::civil::Date;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::ApiError;

#[derive(Serialize)]
struct CanonicalRates {
    version: u8,
    rates: Vec<CanonicalRate>,
}

#[derive(Serialize)]
struct CanonicalRate {
    day: String,
    source: &'static str,
    source_day: Option<String>,
    micro_usd_per_sol: Option<u64>,
}

pub(super) fn rate_fingerprint(rates: &[(Date, Option<DailyRate>)]) -> Result<String, ApiError> {
    let rates = rates
        .iter()
        .map(|(day, rate)| {
            let (source, source_day) = match rate {
                Some(DailyRate::Final(_)) => ("daily_close", Some(day.to_string())),
                Some(DailyRate::Provisional { day, .. }) => ("provisional", Some(day.to_string())),
                None => ("missing", None),
            };
            CanonicalRate {
                day: day.to_string(),
                source,
                source_day,
                micro_usd_per_sol: rate.map(|rate| rate.value().micro_usd_per_sol()),
            }
        })
        .collect();
    let bytes = serde_json::to_vec(&CanonicalRates { version: 1, rates })
        .map_err(|error| ApiError::internal(format!("conversion fingerprint: {error}")))?;
    let digest: String = Sha256::digest(bytes)
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .filter_map(|digit| char::from_digit(u32::from(digit), 16))
        .collect();
    Ok(format!("v1:{digest}"))
}
