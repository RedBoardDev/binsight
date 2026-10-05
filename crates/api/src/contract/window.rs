//! A time window on the wire, and the period a read asks for.

use binsight_engine::portfolio::views::WindowView;
use binsight_ledger::report::period::{Period as LedgerPeriod, WindowScope};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

/// A period ending now: the last N local dates (today included), from local midnight in the
/// instance's time zone.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, ToSchema)]
pub(crate) enum Period {
    /// Since local midnight.
    #[serde(rename = "today")]
    Today,
    /// The last 7 local dates.
    #[serde(rename = "7d")]
    SevenDays,
    /// The last month of local dates (the default).
    #[default]
    #[serde(rename = "1m")]
    OneMonth,
    /// The last three months of local dates.
    #[serde(rename = "3m")]
    ThreeMonths,
    /// The last year of local dates.
    #[serde(rename = "1y")]
    OneYear,
    /// Since the first activity.
    #[serde(rename = "all")]
    All,
}

/// What a window covers: one of the periods, or one local date.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) enum WindowPeriod {
    /// Since local midnight.
    #[serde(rename = "today")]
    Today,
    /// The last 7 local dates.
    #[serde(rename = "7d")]
    SevenDays,
    /// The last month of local dates.
    #[serde(rename = "1m")]
    OneMonth,
    /// The last three months of local dates.
    #[serde(rename = "3m")]
    ThreeMonths,
    /// The last year of local dates.
    #[serde(rename = "1y")]
    OneYear,
    /// Since the first activity.
    #[serde(rename = "all")]
    All,
    /// One local date.
    #[serde(rename = "day")]
    Day,
}

/// The span of time figures cover: from `start` (included) to `end` (excluded).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Window {
    /// The period asked for, or `day` for one local date.
    pub(crate) period: WindowPeriod,
    /// The local date (`YYYY-MM-DD`) when `period` is `day`, otherwise `null`.
    pub(crate) day: Option<String>,
    /// The first instant (RFC 3339, UTC).
    pub(crate) start: Timestamp,
    /// The instant right after the window: now, or the next local midnight for a past day.
    pub(crate) end: Timestamp,
    /// The IANA time zone its days are cut in.
    pub(crate) timezone: String,
}

impl From<Period> for LedgerPeriod {
    fn from(period: Period) -> Self {
        match period {
            Period::Today => Self::Today,
            Period::SevenDays => Self::SevenDays,
            Period::OneMonth => Self::OneMonth,
            Period::ThreeMonths => Self::ThreeMonths,
            Period::OneYear => Self::OneYear,
            Period::All => Self::All,
        }
    }
}

impl From<&WindowView> for Window {
    fn from(window: &WindowView) -> Self {
        let (period, day) = match window.scope {
            WindowScope::Period(period) => (from_ledger(period), None),
            WindowScope::Day(day) => (WindowPeriod::Day, Some(day.to_string())),
        };
        Self {
            period,
            day,
            start: window.start,
            end: window.end,
            timezone: window.timezone.clone(),
        }
    }
}

/// The wire period of a period of the read rules.
fn from_ledger(period: LedgerPeriod) -> WindowPeriod {
    match period {
        LedgerPeriod::Today => WindowPeriod::Today,
        LedgerPeriod::SevenDays => WindowPeriod::SevenDays,
        LedgerPeriod::OneMonth => WindowPeriod::OneMonth,
        LedgerPeriod::ThreeMonths => WindowPeriod::ThreeMonths,
        LedgerPeriod::OneYear => WindowPeriod::OneYear,
        LedgerPeriod::All => WindowPeriod::All,
    }
}

/// The period a read covers.
#[derive(Debug, Clone, Copy, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct PeriodQuery {
    /// `today`, `7d`, `1m` (the default), `3m`, `1y` or `all`.
    #[param(inline)]
    pub(crate) period: Option<Period>,
}

impl PeriodQuery {
    /// The period asked for, `1m` by default.
    pub(crate) fn period(self) -> LedgerPeriod {
        self.period.unwrap_or_default().into()
    }
}
