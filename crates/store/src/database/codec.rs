//! Conversions between Rust values and the SQLite column types the schema uses.
//!
//! SQLite stores bounded integers (timestamps, versions, slots) as signed 64-bit `INTEGER`s. These
//! functions convert explicitly and fail loudly on a value that does not fit, instead of wrapping
//! silently with `as`. They hold no SQL.
//!
//! Amounts are not handled here: they are stored as decimal `TEXT`, and no table stores one yet.

use jiff::Timestamp;

use crate::error::StoreError;

/// A timestamp as stored in an `INTEGER` column: whole seconds since the Unix epoch, in UTC.
///
/// Sub-second precision is dropped on purpose: no stored instant needs it.
pub(crate) fn timestamp_to_sql(instant: Timestamp) -> i64 {
    instant.as_second()
}

/// Reads back a timestamp written by [`timestamp_to_sql`].
pub(crate) fn timestamp_from_sql(seconds: i64) -> Result<Timestamp, StoreError> {
    Timestamp::from_second(seconds).map_err(|_| StoreError::InvalidStoredValue {
        what: "timestamp",
        value: seconds.to_string(),
    })
}

/// An unsigned counter (a slot, a count) as stored in an `INTEGER` column. `what` names the value
/// in the error.
pub(crate) fn unsigned_to_sql(value: u64, what: &'static str) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| StoreError::ValueTooLarge {
        what,
        value: value.to_string(),
    })
}

/// Reads back a value written by [`unsigned_to_sql`].
pub(crate) fn unsigned_from_sql(stored: i64, what: &'static str) -> Result<u64, StoreError> {
    u64::try_from(stored).map_err(|_| StoreError::InvalidStoredValue {
        what,
        value: stored.to_string(),
    })
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
    fn round_trips_a_timestamp_to_the_second() {
        let instant = Timestamp::from_second(1_790_000_000).unwrap();
        assert_eq!(
            timestamp_from_sql(timestamp_to_sql(instant)).unwrap(),
            instant
        );
    }

    #[test]
    fn refuses_a_stored_timestamp_out_of_range() {
        assert!(matches!(
            timestamp_from_sql(i64::MAX),
            Err(StoreError::InvalidStoredValue {
                what: "timestamp",
                ..
            })
        ));
    }

    #[test]
    fn stores_unsigned_values_up_to_the_largest_sqlite_integer() {
        let largest = u64::try_from(i64::MAX).unwrap();
        assert_eq!(unsigned_to_sql(largest, "slot").unwrap(), i64::MAX);
        assert_eq!(unsigned_from_sql(i64::MAX, "slot").unwrap(), largest);
        assert!(matches!(
            unsigned_to_sql(largest + 1, "slot"),
            Err(StoreError::ValueTooLarge { what: "slot", .. })
        ));
        assert!(unsigned_from_sql(-1, "slot").is_err());
    }

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
