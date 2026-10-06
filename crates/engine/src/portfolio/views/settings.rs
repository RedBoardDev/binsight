//! The settings of the instance that every client shares.

use binsight_ledger::report::valued::Currency;

/// The settings of the instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceSettings {
    /// The IANA name of the time zone that decides where days start, such as `Europe/Paris`.
    pub timezone: String,
    /// Whether the owner chose the time zone or it is still the default.
    pub timezone_source: TimezoneSource,
    /// The currency figures are shown in unless a client asks for another.
    pub default_currency: Currency,
    /// Whether clients hide amounts until the owner reveals them.
    pub hide_amounts_by_default: bool,
}

impl Default for InstanceSettings {
    /// The settings of an instance whose owner changed nothing: UTC days, SOL figures, amounts
    /// shown.
    fn default() -> Self {
        Self {
            timezone: "UTC".to_owned(),
            timezone_source: TimezoneSource::Default,
            default_currency: Currency::Sol,
            hide_amounts_by_default: false,
        }
    }
}

/// Where the time zone setting comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TimezoneSource {
    /// The default (UTC): clients may suggest the browser's time zone once.
    Default,
    /// The owner chose it.
    Owner,
}
