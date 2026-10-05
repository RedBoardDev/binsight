//! Which wallets a read covers, and the instant and time zone it is read at.

use binsight_solana::Address;
use jiff::Timestamp;
use jiff::tz::TimeZone;

/// The wallets a read covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scope {
    /// Every tracked wallet.
    All,
    /// One tracked wallet.
    Wallet(Address),
}

impl Scope {
    /// Whether `wallet` is in the scope.
    pub fn includes(self, wallet: Address) -> bool {
        match self {
            Self::All => true,
            Self::Wallet(address) => address == wallet,
        }
    }
}

/// When and where a read happens: the current instant and the instance's time zone, which
/// decides where local days start.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadContext {
    /// The current instant.
    pub now: Timestamp,
    /// The instance's time zone.
    pub timezone: TimeZone,
}
