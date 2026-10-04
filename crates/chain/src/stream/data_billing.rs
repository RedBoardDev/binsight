//! How much of the data a connection delivered is billed, unit by unit.
//!
//! Helius bills streamed data per started tenth of a megabyte, counted over the whole
//! connection, not per message: a hundred small notifications cost one unit, not a hundred. This
//! module counts the bytes of one connection and says how many new units each message starts; it
//! is pure.

use crate::governor::STREAM_DATA_UNIT_BYTES;

/// The data one connection delivered.
#[derive(Debug, Default)]
pub(crate) struct DataBilling {
    bytes: u64,
    units_billed: u64,
}

impl DataBilling {
    /// Counts `bytes` more delivered data; returns how many new units they started.
    pub(crate) fn delivered(&mut self, bytes: usize) -> u64 {
        self.bytes = self
            .bytes
            .saturating_add(u64::try_from(bytes).unwrap_or(u64::MAX));
        let units = self.bytes.div_ceil(STREAM_DATA_UNIT_BYTES);
        let started = units.saturating_sub(self.units_billed);
        self.units_billed = units;
        started
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bills_websocket_data_per_started_tenth_of_a_megabyte() {
        let mut billing = DataBilling::default();

        assert_eq!(billing.delivered(0), 0);
        assert_eq!(billing.delivered(1), 1);
        assert_eq!(billing.delivered(99_999), 0);
        assert_eq!(billing.delivered(1), 1);
        assert_eq!(billing.delivered(250_000), 2);
    }
}
