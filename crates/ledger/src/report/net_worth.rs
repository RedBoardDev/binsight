//! The net worth of a set of wallets now, in its four parts.
//!
//! Net worth = idle (free SOL and priced tokens) + liquidity in open positions + fees they could
//! claim + rent the owner gets back by closing accounts. Each part is valued at the spot rate and
//! the total is their sum, so the total equals the sum of the parts in both currencies. A token
//! without a price is left out and makes the idle part and the total partial.

use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use binsight_core::money::{SignedLamports, SolUsdRate};

use super::figure::{Figure, Reason, Reasons};
use super::open::OpenValuation;
use super::valued::{Valued, sum_valued};
use crate::facts::WalletHoldings;

/// The net worth and its parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetWorth {
    /// idle + lp + unclaimed fees + recoverable rent.
    pub total: Figure<Valued>,
    /// Free SOL and priced tokens.
    pub idle: Figure<Valued>,
    /// The value of the liquidity in open positions.
    pub lp: Figure<Valued>,
    /// The fees the open positions could claim.
    pub unclaimed_fees: Figure<Valued>,
    /// The rent the owner gets back by closing accounts.
    pub recoverable_rent: Figure<Valued>,
}

impl NetWorth {
    /// The net worth of wallets holding `holdings` outside positions and `open` positions,
    /// valued at the `spot` rate.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a sum overflows.
    pub fn of<'a>(
        holdings: impl IntoIterator<Item = &'a WalletHoldings>,
        open: impl IntoIterator<Item = &'a OpenValuation> + Clone,
        spot: Option<SolUsdRate>,
    ) -> Result<Self, AmountError> {
        let holdings: Vec<&WalletHoldings> = holdings.into_iter().collect();
        let idle = sum_valued(
            holdings
                .iter()
                .map(|wallet| idle_of(wallet, spot))
                .collect::<Result<Vec<_>, _>>()?,
        )?;
        let recoverable_rent = sum_valued(
            holdings
                .iter()
                .map(|wallet| {
                    Valued::of_sol(SignedLamports::from(wallet.recoverable_rent), spot)
                        .map(Figure::Complete)
                })
                .collect::<Result<Vec<_>, _>>()?,
        )?;
        let lp = sum_valued(
            open.clone()
                .into_iter()
                .map(|position| position.value.clone()),
        )?;
        let unclaimed_fees = sum_valued(
            open.into_iter()
                .map(|position| position.unclaimed_fees.clone()),
        )?;
        let total = sum_valued([
            idle.clone(),
            lp.clone(),
            unclaimed_fees.clone(),
            recoverable_rent.clone(),
        ])?;
        Ok(Self {
            total,
            idle,
            lp,
            unclaimed_fees,
            recoverable_rent,
        })
    }
}

/// The idle part of one wallet, partial when it holds a token without a price.
fn idle_of(
    wallet: &WalletHoldings,
    spot: Option<SolUsdRate>,
) -> Result<Figure<Valued>, AmountError> {
    let value = Valued::of_sol(SignedLamports::from(wallet.idle), spot)?;
    if wallet.unpriced.is_empty() {
        return Ok(Figure::Complete(value));
    }
    let reasons: Reasons = wallet
        .unpriced
        .iter()
        .map(|token| Reason::UnpricedToken {
            wallet: wallet.wallet,
            mint: token.mint,
        })
        .collect();
    Ok(Figure::from_parts(value, Exactness::Partial, reasons))
}

#[cfg(test)]
mod tests {
    use binsight_core::units::{Lamports, RawTokenAmount};
    use binsight_solana::Address;
    use jiff::Timestamp;

    use super::*;
    use crate::facts::UnpricedToken;

    fn holdings(idle: u64, unpriced: Vec<UnpricedToken>) -> WalletHoldings {
        WalletHoldings {
            wallet: Address::from_bytes([1; 32]),
            idle: Lamports(idle),
            recoverable_rent: Lamports(7),
            unpriced,
            observed_at: Timestamp::UNIX_EPOCH,
        }
    }

    #[test]
    fn adds_the_parts_in_both_currencies() {
        let spot = SolUsdRate::new(100_000_000);
        let net_worth = NetWorth::of(&[holdings(1_000_000_000, Vec::new())], &[], spot).unwrap();
        let total = net_worth.total.value().unwrap();
        assert_eq!(total.sol, Some(SignedLamports(1_000_000_007)));
        assert_eq!(net_worth.total.exactness(), Exactness::Complete);
        let parts = [&net_worth.idle, &net_worth.recoverable_rent];
        let usd: i128 = parts
            .iter()
            .map(|part| part.value().unwrap().usd.unwrap().0)
            .sum();
        assert_eq!(total.usd.unwrap().0, usd);
    }

    #[test]
    fn makes_the_total_partial_with_an_unpriced_token() {
        let token = UnpricedToken {
            mint: Address::from_bytes([2; 32]),
            amount: RawTokenAmount(1_240_000),
        };
        let net_worth = NetWorth::of(&[holdings(5, vec![token])], &[], None).unwrap();
        assert_eq!(net_worth.total.exactness(), Exactness::Partial);
        assert!(net_worth.total.reasons().contains(&Reason::UnpricedToken {
            wallet: Address::from_bytes([1; 32]),
            mint: Address::from_bytes([2; 32]),
        }));
    }
}
