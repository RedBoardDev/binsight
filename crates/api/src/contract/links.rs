//! Shared external links for on-chain accounts and the position's displayed base token.
//!
//! These pure constructors describe destination routes; they neither contact those services
//! nor guarantee a page exists, particularly for the synthetic addresses of the demo.

use binsight_solana::Address;
use serde::Serialize;
use utoipa::ToSchema;

/// External destinations shared by position lists and details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct PositionLinks {
    /// The DLMM pool on Meteora; does not select a position.
    pub(crate) meteora: String,
    /// The position account on Solscan, shared by every position that used that address.
    pub(crate) solscan: String,
    /// The displayed base token on GMGN, following the pool's selected quote convention.
    pub(crate) gmgn: String,
}

/// External destinations shared by every reference to a tracked wallet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct WalletLinks {
    /// The wallet's Jupiter portfolio.
    pub(crate) jupiter_portfolio: String,
    /// The wallet account on Solscan.
    pub(crate) solscan: String,
}

impl PositionLinks {
    /// Links for the position account and pool, and the displayed base mint.
    pub(crate) fn of(position: Address, pool: Address, displayed_base_mint: Address) -> Self {
        Self {
            meteora: format!("https://app.meteora.ag/dlmm/{pool}"),
            solscan: solscan_account(position),
            gmgn: format!("https://gmgn.ai/sol/token/{displayed_base_mint}"),
        }
    }
}

impl WalletLinks {
    /// Links for the wallet account.
    pub(crate) fn of(wallet: Address) -> Self {
        Self {
            jupiter_portfolio: format!("https://jup.ag/portfolio/{wallet}"),
            solscan: solscan_account(wallet),
        }
    }
}

fn solscan_account(address: Address) -> String {
    format!("https://solscan.io/account/{address}")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use binsight_core::units::{Decimals, Lamports};
    use binsight_engine::portfolio::query::{
        ClosedPageRequest, ClosedQuery, ClosedSort, SortOrder, closed_page,
    };
    use binsight_engine::portfolio::views::{SyncState, WalletColor, WalletSync};
    use binsight_engine::portfolio::{
        ReadContext, Scope, Snapshot, SnapshotFacts, TrackedWallet, WalletLabel,
    };
    use binsight_ledger::facts::*;
    use binsight_ledger::report::valued::Currency;
    use binsight_solana::{Address, Signature};
    use jiff::tz::TimeZone;
    use jiff::{SignedDuration, Timestamp};

    use super::super::ClosedPositionRow;

    fn token(byte: u8, kind: TokenKind) -> TokenFacts {
        TokenFacts {
            mint: Address::from_bytes([byte; 32]),
            symbol: None,
            name: None,
            decimals: if matches!(kind, TokenKind::Sol) {
                Decimals::SOL
            } else {
                Decimals(6)
            },
            kind,
        }
    }

    fn wallet(now: Timestamp) -> TrackedWallet {
        let address = Address::from_bytes([7; 32]);
        TrackedWallet {
            facts: WalletFacts {
                address,
                added_at: now,
                history: HistoryCoverage::Complete,
            },
            label: WalletLabel::short_address(&address),
            color: WalletColor::Wallet1,
            holdings: WalletHoldings {
                wallet: address,
                idle: Lamports(0),
                recoverable_rent: Lamports(0),
                unpriced: vec![],
                observed_at: now,
            },
            sync: WalletSync {
                state: SyncState::Live,
                lag_seconds: None,
                last_tx_at: None,
                indexed_tx: 0,
                import: None,
            },
        }
    }

    fn position(signature: u8, pool: u8, now: Timestamp) -> ClosedPositionFacts {
        ClosedPositionFacts {
            id: PositionId {
                address: Address::from_bytes([8; 32]),
                opened_by: Signature::from_bytes([signature; 64]),
            },
            wallet: Address::from_bytes([7; 32]),
            pool: Address::from_bytes([pool; 32]),
            strategy: Some(Strategy::Spot),
            opened_at: now
                .checked_sub(SignedDuration::from_hours(i64::from(4 - signature)))
                .unwrap(),
            closed_at: now
                .checked_sub(SignedDuration::from_hours(i64::from(3 - signature)))
                .unwrap(),
            invested: QuoteUnits(1),
            withdrawn: QuoteUnits(2),
            claimed_fees: QuoteUnits(0),
            rewards: QuoteUnits(0),
            method: PnlMethod::Pool,
            unpriced_rewards: 0,
            history: PositionHistory::Whole,
            dust_movements: 0,
            unpriced_movements: UnpricedMovements::default(),
        }
    }

    #[test]
    fn links_the_displayed_base_and_the_same_account_for_a_reused_address() {
        let now = Timestamp::from_second(1_790_000_000).unwrap();
        let pools = vec![
            PoolFacts {
                address: Address::from_bytes([3; 32]),
                bin_step: 80,
                base: token(1, TokenKind::Usdc),
                quote: token(2, TokenKind::Sol),
            },
            PoolFacts {
                address: Address::from_bytes([4; 32]),
                bin_step: 80,
                base: token(5, TokenKind::Other),
                quote: token(6, TokenKind::Other),
            },
        ];
        let snapshot = Snapshot::new(SnapshotFacts {
            pools,
            closed: vec![
                position(1, 3, now),
                position(2, 3, now),
                position(3, 4, now),
            ],
            wallets: vec![wallet(now)],
            ..SnapshotFacts::default()
        })
        .unwrap();
        let query = ClosedQuery {
            scope: Scope::All,
            day: None,
            search: None,
            outcomes: BTreeSet::new(),
            strategies: BTreeSet::new(),
            pools: BTreeSet::new(),
            sort: ClosedSort::ClosedAt,
            order: SortOrder::Ascending,
            currency: Currency::Usd,
        };
        let page = closed_page(
            &snapshot,
            &query,
            ClosedPageRequest {
                as_of: None,
                after: None,
                limit: 3,
            },
            &ReadContext {
                now,
                timezone: TimeZone::UTC,
            },
        )
        .unwrap();
        let rows: Vec<ClosedPositionRow> = page.items.iter().map(Into::into).collect();
        assert_eq!(rows.len(), 3);
        let selected: Vec<_> = rows
            .iter()
            .filter(|row| row.pool.address == Address::from_bytes([3; 32]).to_string())
            .collect();
        assert_eq!(selected.len(), 2);
        assert_ne!(selected[0].id, selected[1].id);
        assert_eq!(selected[0].links, selected[1].links);
        assert_eq!(
            selected[0].links.solscan,
            format!(
                "https://solscan.io/account/{}",
                Address::from_bytes([8; 32])
            )
        );
        assert_eq!(
            selected[0].links.meteora,
            format!(
                "https://app.meteora.ag/dlmm/{}",
                Address::from_bytes([3; 32])
            )
        );
        assert_eq!(
            selected[0].links.gmgn,
            format!("https://gmgn.ai/sol/token/{}", Address::from_bytes([1; 32]))
        );
        let unsupported = rows
            .iter()
            .find(|row| row.pool.address == Address::from_bytes([4; 32]).to_string())
            .unwrap();
        assert_eq!(
            unsupported.links.gmgn,
            format!("https://gmgn.ai/sol/token/{}", Address::from_bytes([5; 32]))
        );
        assert_eq!(
            unsupported.pool.base.mint,
            Address::from_bytes([5; 32]).to_string()
        );
        assert_eq!(unsupported.links.solscan, selected[0].links.solscan);
    }
}
