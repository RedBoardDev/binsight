//! The history of one wallet, indexed once so that its real PnL at any instant is a lookup.

use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use binsight_core::money::SignedLamports;
use jiff::Timestamp;

use super::PnlPoint;
use super::running_sum::RunningSum;
use crate::facts::{ClosedPositionFacts, OpenPnlMark, SolUsdRates, WalletEntry, WalletFacts};
use crate::report::closed::ClosedValuation;
use crate::report::figure::{Combination, Figure, Reason, Reasons};
use crate::report::valued::Valued;

/// Everything a wallet's history is built from.
#[derive(Debug, Clone, Copy)]
pub struct WalletHistoryFacts<'a> {
    /// The wallet.
    pub wallet: &'a WalletFacts,
    /// Its closed positions with their valuation.
    pub closed: &'a [(&'a ClosedPositionFacts, &'a ClosedValuation)],
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
        let valued_entries = |is_capital: bool| {
            facts
                .entries
                .iter()
                .filter(move |entry| entry.kind.is_capital() == is_capital)
                .map(|entry| {
                    let value = Valued::of_sol(entry.amount, facts.rates.on(entry.at))?;
                    Ok((entry.at, Figure::Complete(value)))
                })
                .collect::<Result<Vec<_>, AmountError>>()
        };
        let mut marks = facts.marks.to_vec();
        marks.sort_by_key(|mark| mark.at);
        let realized = RunningSum::new(closed_pnl.iter().cloned().chain(valued_entries(false)?))?;
        let capital = RunningSum::new(valued_entries(true)?)?;
        let first_activity = [
            realized.first_instant(),
            capital.first_instant(),
            marks.first().map(|mark| mark.at),
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

    /// The net capital put in at or before `instant`.
    pub fn capital_at(&self, instant: Timestamp) -> Figure<Valued> {
        self.capital.at(instant)
    }

    /// The net capital put in at or after `start` and before `end`.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when the difference overflows.
    pub fn capital_during(
        &self,
        start: Timestamp,
        end: Timestamp,
    ) -> Result<Figure<Valued>, AmountError> {
        self.capital.during(start, end)
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
        self.positions.during(start, end)
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

    /// The wallet's point at `instant`, read at its last mark at or before it.
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
                capital: self.capital.at(instant),
                net_worth: unavailable,
            });
        }
        let (cutoff, open_pnl) = self
            .mark_at(instant)
            .map_or((instant, SignedLamports::ZERO), |mark| {
                (mark.at, mark.open_pnl)
            });
        if self.first_activity.is_none_or(|first| cutoff < first) {
            return Ok(zero_point());
        }
        let capital = self.capital.at(cutoff);
        let rate = rates.on(cutoff);
        let both = self.realized.at(cutoff).combine(
            capital.clone(),
            Combination::Sum,
            |realized, capital| {
                let real_pnl_sol = realized.sol.try_add(open_pnl)?;
                let net_worth = Valued::of_sol(capital.sol.try_add(real_pnl_sol)?, rate)?;
                let real_pnl_usd = match (net_worth.usd, capital.usd) {
                    (Some(worth), Some(put_in)) => Some(worth.try_sub(put_in)?),
                    _ => None,
                };
                let real_pnl = Valued {
                    sol: real_pnl_sol,
                    usd: real_pnl_usd,
                };
                Ok::<_, AmountError>((real_pnl, net_worth))
            },
        )?;
        let both = self.reconstructed(both, cutoff);
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
