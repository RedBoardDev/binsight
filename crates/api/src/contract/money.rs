//! An exact amount of money and its unit.

use binsight_ledger::report::valued;
use serde::Serialize;
use utoipa::ToSchema;

use super::decimal::DecimalString;

/// An exact amount of money.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Money {
    /// The amount in whole units (`"1.5"` SOL), signed for gains and losses.
    pub(crate) amount: DecimalString,
    /// The unit.
    pub(crate) unit: MoneyUnit,
}

/// The unit of an amount.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MoneyUnit {
    /// SOL.
    Sol,
    /// US dollars.
    Usd,
    /// USD Coin.
    Usdc,
    /// Tether USD.
    Usdt,
}

impl From<valued::Money> for Money {
    fn from(money: valued::Money) -> Self {
        Self {
            amount: DecimalString::from_canonical(money.to_decimal_string()),
            unit: match money.unit {
                valued::MoneyUnit::Sol => MoneyUnit::Sol,
                valued::MoneyUnit::Usd => MoneyUnit::Usd,
                valued::MoneyUnit::Usdc => MoneyUnit::Usdc,
                valued::MoneyUnit::Usdt => MoneyUnit::Usdt,
            },
        }
    }
}
