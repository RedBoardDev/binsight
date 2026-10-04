//! How long a listing that keeps failing waits before the next attempt.
//!
//! A history page or a check that cannot be listed or written is tried again after 30 seconds,
//! then twice as long after each failure in a row, up to an hour: a page that keeps failing must
//! neither block the other wallets nor spend credits every few seconds. Both schedules read the
//! same rule here; this module is pure.

use jiff::SignedDuration;

/// The delay before trying again after the first failure in a row.
const FIRST_RETRY_DELAY_SECS: i64 = 30;

/// The longest delay between two attempts.
const LONGEST_RETRY_DELAY_SECS: i64 = 3_600;

/// The delay after `failures_in_a_row` failures: 30 s doubled for each failure after the first,
/// at most an hour.
pub(super) fn retry_delay(failures_in_a_row: u32) -> SignedDuration {
    let doublings = failures_in_a_row.saturating_sub(1);
    let secs = 2_i64
        .checked_pow(doublings)
        .and_then(|factor| factor.checked_mul(FIRST_RETRY_DELAY_SECS))
        .map_or(LONGEST_RETRY_DELAY_SECS, |secs| {
            secs.min(LONGEST_RETRY_DELAY_SECS)
        });
    SignedDuration::from_secs(secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_the_delay_after_each_failure_in_a_row_up_to_an_hour() {
        let delays: Vec<i64> = (1..=10)
            .map(|failures| retry_delay(failures).as_secs())
            .collect();

        assert_eq!(
            delays,
            [30, 60, 120, 240, 480, 960, 1_920, 3_600, 3_600, 3_600]
        );
    }
}
