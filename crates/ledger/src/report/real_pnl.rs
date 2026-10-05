//! The real PnL of a set of wallets, now and at any past instant, and the gain over a window.
//!
//! Real PnL = net worth − net capital put in by the owner. Now, the net worth is observed; in the
//! past capital and realized amounts include the requested instant; the open PnL uses the last
//! mark at or before it, preserving its source quality. A preceding mark is estimated while
//! positions are open; no preceding mark makes their open PnL unavailable. Without open
//! exposure, the open PnL is known zero. The dollar side is the SOL net worth at that instant minus
//! the capital, each deposit at the rate of its day. The gain over a window is the real PnL now
//! minus the real PnL at its start. A wallet whose history is still importing has no real PnL;
//! a point before a wallet was added is estimated.

mod running_sum;
mod wallet_history;

use binsight_core::error::AmountError;
use binsight_core::ratio::Percent;
use jiff::Timestamp;

pub use running_sum::RunningSum;
pub use wallet_history::{WalletHistory, WalletHistoryFacts};

use super::ReadRuleError;
use super::figure::{Figure, Reasons};
use super::period::{Period, Window, WindowScope};
use super::valued::{Currency, Valued, percent_of, subtract_valued, sum_valued};
use crate::facts::SolUsdRates;

/// The real PnL, net capital and net worth of a set of wallets at one instant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PnlPoint {
    /// net worth − net capital.
    pub real_pnl: Figure<Valued>,
    /// What the owner put in, net of what they took out.
    pub capital: Figure<Valued>,
    /// What the wallets are worth.
    pub net_worth: Figure<Valued>,
}

/// The history of the real PnL of a set of wallets.
#[derive(Debug, Clone, Copy)]
pub struct PnlTimeline<'a> {
    wallets: &'a [&'a WalletHistory],
    rates: &'a SolUsdRates,
}

impl<'a> PnlTimeline<'a> {
    /// The timeline of `wallets`, with `rates` to value past net worths in dollars.
    pub fn new(wallets: &'a [&'a WalletHistory], rates: &'a SolUsdRates) -> Self {
        Self { wallets, rates }
    }

    /// The point at `instant` in the past, rebuilt from the facts.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a sum overflows.
    pub fn at(&self, instant: Timestamp) -> Result<PnlPoint, AmountError> {
        let points = self
            .wallets
            .iter()
            .map(|wallet| wallet.point_at(instant, self.rates))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(PnlPoint {
            real_pnl: sum_valued(points.iter().map(|point| point.real_pnl.clone()))?,
            capital: sum_valued(points.iter().map(|point| point.capital.clone()))?,
            net_worth: sum_valued(points.iter().map(|point| point.net_worth.clone()))?,
        })
    }

    /// The point now, from the observed `net_worth`.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a sum overflows.
    pub fn live(
        &self,
        net_worth: &Figure<Valued>,
        now: Timestamp,
    ) -> Result<PnlPoint, AmountError> {
        let capital = sum_valued(self.wallets.iter().map(|wallet| wallet.capital_at(now)))?;
        let incomplete: Reasons = self
            .wallets
            .iter()
            .filter_map(|wallet| wallet.incomplete_reason())
            .collect();
        let real_pnl = if incomplete.is_empty() {
            subtract_valued(net_worth.clone(), capital.clone())?
        } else {
            Figure::Unavailable {
                reasons: incomplete,
            }
        };
        Ok(PnlPoint {
            real_pnl,
            capital,
            net_worth: net_worth.clone(),
        })
    }

    /// The gain over `window` (real PnL at its end, `live`, minus at its start) and the gain as a
    /// percentage of the net worth at its start, in `currency`.
    ///
    /// # Errors
    ///
    /// Returns [`ReadRuleError`] when a sum or the quotient overflows.
    pub fn gain(
        &self,
        window: &Window,
        live: &PnlPoint,
        currency: Currency,
    ) -> Result<(Figure<Valued>, Figure<Percent>), ReadRuleError> {
        let start = self.at(window.start)?;
        let gain = subtract_valued(live.real_pnl.clone(), start.real_pnl)?;
        let percent = percent_of(&gain, &start.net_worth, currency)?;
        Ok((gain, percent))
    }

    /// The capital put in during `window`, net of what was taken out.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a sum overflows.
    pub fn net_deposits(&self, window: &Window) -> Result<Figure<Valued>, AmountError> {
        if window.scope == WindowScope::Period(Period::All) {
            let reasons: Reasons = self
                .wallets
                .iter()
                .filter_map(|wallet| wallet.incomplete_reason())
                .collect();
            if !reasons.is_empty() {
                return Ok(Figure::Unavailable { reasons });
            }
        }
        let deposits = self
            .wallets
            .iter()
            .map(|wallet| wallet.capital_during(window.start, window.end))
            .collect::<Result<Vec<_>, _>>()?;
        sum_valued(deposits)
    }

    /// The PnL of the positions closed at or after `start` and before `end`.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a sum overflows.
    pub fn positions_pnl(
        &self,
        start: Timestamp,
        end: Timestamp,
    ) -> Result<Figure<Valued>, AmountError> {
        let pnl = self
            .wallets
            .iter()
            .map(|wallet| wallet.positions_pnl_during(start, end))
            .collect::<Result<Vec<_>, _>>()?;
        sum_valued(pnl)
    }

    /// The first instant any of the wallets did something, if any.
    pub fn first_activity(&self) -> Option<Timestamp> {
        self.wallets
            .iter()
            .filter_map(|wallet| wallet.first_activity())
            .min()
    }
}
