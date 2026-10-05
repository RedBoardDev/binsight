//! The history of one wallet, indexed once so that its real PnL at any instant is a lookup.

use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use binsight_core::money::SignedLamports;
use jiff::Timestamp;

mod exposure;
mod point;

use exposure::OpenExposure;

use super::PnlPoint;
use super::running_sum::RunningSum;
use crate::facts::{
    ClosedPositionFacts, OpenPnlMark, OpenPositionFacts, SolUsdRates, WalletEntry, WalletFacts,
};
use crate::report::closed::ClosedValuation;
use crate::report::figure::{Figure, Reason, Reasons, history_reasons};
use crate::report::valued::Valued;

/// Everything a wallet's history is built from.
#[derive(Debug, Clone, Copy)]
pub struct WalletHistoryFacts<'a> {
    /// The wallet.
    pub wallet: &'a WalletFacts,
    /// Its closed positions with their valuation.
    pub closed: &'a [(&'a ClosedPositionFacts, &'a ClosedValuation)],
    /// Its currently open positions, including their proven opening instant.
    pub open: &'a [&'a OpenPositionFacts],
    /// Its entries outside positions.
    pub entries: &'a [&'a WalletEntry],
    /// Its open-PnL marks.
    pub marks: &'a [OpenPnlMark],
    /// The rates entries are valued at.
    pub rates: &'a SolUsdRates,
}

/// One wallet's history: running sums of what it realized, of its closed positions' PnL and of
/// its capital, and its open-PnL marks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletHistory {
    wallet: WalletFacts,
    realized: RunningSum,
    positions: RunningSum,
    capital: RunningSum,
    marks: Vec<OpenPnlMark>,
    exposure: OpenExposure,
    first_activity: Option<Timestamp>,
}

impl WalletHistory {
    /// Indexes the history of a wallet.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a sum overflows.
    pub fn new(facts: WalletHistoryFacts<'_>) -> Result<Self, AmountError> {
        let closed_pnl: Vec<(Timestamp, Figure<Valued>)> = facts
            .closed
            .iter()
            .map(|(position, valuation)| (position.closed_at, valuation.pnl.clone()))
            .collect();
        let realized_pnl = closed_pnl.iter().cloned();
        let valued_entries = |is_capital: bool| {
            facts
                .entries
                .iter()
                .filter(move |entry| entry.kind.is_capital() == is_capital)
                .map(|entry| {
                    let value = Valued::of_sol_at(entry.amount, facts.rates.on(entry.at))?;
                    Ok((entry.at, Figure::Complete(value)))
                })
                .collect::<Result<Vec<_>, AmountError>>()
        };
        let mut marks = facts.marks.to_vec();
        marks.sort_by_key(|mark| mark.at);
        let realized = RunningSum::new(realized_pnl.chain(valued_entries(false)?))?;
        let capital = RunningSum::new(valued_entries(true)?)?;
        let exposure = OpenExposure::of(facts);
        let first_activity = [
            realized.first_instant(),
            capital.first_instant(),
            marks.first().map(|mark| mark.at),
            exposure.first_activity(),
        ]
        .into_iter()
        .flatten()
        .min();
        Ok(Self {
            wallet: facts.wallet.clone(),
            positions: RunningSum::new(closed_pnl)?,
            realized,
            capital,
            marks,
            exposure,
            first_activity,
        })
    }

    /// The wallet's address.
    pub fn address(&self) -> binsight_solana::Address {
        self.wallet.address
    }

    /// The first instant the wallet did anything, if ever.
    pub fn first_activity(&self) -> Option<Timestamp> {
        self.first_activity
    }

    /// The net capital put in at or before `instant`; unknown until the whole origin is indexed.
    pub fn capital_at(&self, instant: Timestamp) -> Figure<Valued> {
        self.incomplete_reason()
            .map_or_else(|| self.capital.at(instant), Figure::unavailable)
    }

    /// The net capital put in at or after `start` and before `end`.
    /// Unknown when the indexed history does not cover the whole window.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when the difference overflows.
    pub fn capital_during(
        &self,
        start: Timestamp,
        end: Timestamp,
    ) -> Result<Figure<Valued>, AmountError> {
        let reasons = history_reasons([&self.wallet], Some(start));
        if reasons.is_empty() {
            self.capital.during(start, end)
        } else {
            Ok(Figure::Unavailable { reasons })
        }
    }

    /// The PnL of the positions closed at or after `start` and before `end`.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when the difference overflows.
    pub fn positions_pnl_during(
        &self,
        start: Timestamp,
        end: Timestamp,
    ) -> Result<Figure<Valued>, AmountError> {
        let reasons = history_reasons([&self.wallet], Some(start));
        if reasons.is_empty() {
            self.positions.during(start, end)
        } else {
            Ok(Figure::Unavailable { reasons })
        }
    }

    /// Why the wallet has no real PnL yet: its history is still importing.
    pub fn incomplete_reason(&self) -> Option<Reason> {
        match self.wallet.history {
            crate::facts::HistoryCoverage::Complete => None,
            crate::facts::HistoryCoverage::Importing { progress, .. } => {
                Some(Reason::HistoryIncomplete {
                    wallet: self.wallet.address,
                    progress,
                })
            }
        }
    }

    /// The wallet's last open-PnL mark at or before `instant`.
    pub fn mark_at(&self, instant: Timestamp) -> Option<&OpenPnlMark> {
        let count = self.marks.partition_point(|mark| mark.at <= instant);
        count.checked_sub(1).and_then(|last| self.marks.get(last))
    }

    /// The open PnL at `instant`, preserving source quality and the age of its last mark.
    ///
    /// With no open exposure the value is known zero. With exposure but no preceding mark,
    /// it is unavailable rather than an invented zero.
    pub fn open_pnl_at(&self, instant: Timestamp) -> Figure<SignedLamports> {
        if !self.exposure.is_open_at(instant) {
            return Figure::Complete(SignedLamports::ZERO);
        }
        let Some(mark) = self.mark_at(instant) else {
            return Figure::unavailable(Reason::MissingOpenPnlMark {
                wallet: self.wallet.address,
            });
        };
        if mark.at == instant {
            return mark.open_pnl.clone();
        }
        let age_seconds = instant.duration_since(mark.at).as_secs().unsigned_abs();
        mark.open_pnl.clone().degraded(
            Exactness::Estimated,
            Reasons::from([Reason::StaleMark { age_seconds }]),
        )
    }

    /// The wallet's point at `instant`; capital and realized amounts include that instant.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a sum overflows.
    pub fn point_at(
        &self,
        instant: Timestamp,
        rates: &SolUsdRates,
    ) -> Result<PnlPoint, AmountError> {
        if let Some(reason) = self.incomplete_reason() {
            let unavailable = Figure::unavailable(reason);
            return Ok(PnlPoint {
                real_pnl: unavailable.clone(),
                capital: self.capital_at(instant),
                net_worth: unavailable,
            });
        }
        if self.first_activity.is_none_or(|first| instant < first) {
            return Ok(zero_point());
        }
        let capital = self.capital.at(instant);
        let both = point::reconstruct(
            &capital,
            self.realized.at(instant),
            self.open_pnl_at(instant),
            rates.on(instant),
        )?;
        let both = self.reconstructed(both, instant);
        Ok(PnlPoint {
            real_pnl: both.clone().map(|(real_pnl, _)| real_pnl),
            net_worth: both.map(|(_, net_worth)| net_worth),
            capital,
        })
    }

    /// Marks a figure read before the wallet was added as estimated.
    fn reconstructed<T>(&self, figure: Figure<T>, cutoff: Timestamp) -> Figure<T> {
        if cutoff >= self.wallet.added_at {
            return figure;
        }
        let reason = Reason::ReconstructedHistory {
            wallet: self.wallet.address,
            until: self.wallet.added_at,
        };
        figure.degraded(Exactness::Estimated, Reasons::from([reason]))
    }
}

/// A point before any activity: nothing was put in, gained or held.
fn zero_point() -> PnlPoint {
    PnlPoint {
        real_pnl: Figure::Complete(Valued::ZERO),
        capital: Figure::Complete(Valued::ZERO),
        net_worth: Figure::Complete(Valued::ZERO),
    }
}

#[cfg(test)]
#[path = "wallet_history/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "wallet_history/mark_quality_tests.rs"]
mod mark_quality_tests;

#[cfg(test)]
mod capital_quality_tests;
