//! Conversions between Rust values and the SQLite column types the schema uses.
//!
//! SQLite stores bounded integers (timestamps, versions, slots) as signed 64-bit `INTEGER`s. These
//! functions convert explicitly and fail loudly on a value that does not fit, instead of wrapping
//! silently with `as`. They hold no SQL.

use jiff::Timestamp;

use crate::error::StoreError;

/// A timestamp as stored in an `INTEGER` column: whole seconds since the Unix epoch, in UTC.
///
/// Sub-second precision is dropped on purpose: no stored instant needs it.
pub(crate) fn timestamp_to_sql(instant: Timestamp) -> i64 {
    instant.as_second()
}

/// A schema or calculation version as stored in an `INTEGER` column.
pub(crate) fn version_to_sql(version: u32) -> i64 {
    i64::from(version)
}

/// Reads back a version written by [`version_to_sql`].
pub(crate) fn version_from_sql(stored: i64) -> Result<u32, StoreError> {
    u32::try_from(stored).map_err(|_| StoreError::InvalidStoredValue {
        what: "version",
        value: stored.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_the_sub_second_part_of_a_timestamp() {
        let instant = Timestamp::new(1_790_000_000, 999_000_000).unwrap();
        assert_eq!(timestamp_to_sql(instant), 1_790_000_000);
    }

    #[test]
    fn round_trips_every_version_and_refuses_negative_ones() {
        for version in [0, 1, u32::MAX] {
            assert_eq!(version_from_sql(version_to_sql(version)).unwrap(), version);
        }
        assert!(version_from_sql(-1).is_err());
        assert!(version_from_sql(i64::from(u32::MAX) + 1).is_err());
    }
}
