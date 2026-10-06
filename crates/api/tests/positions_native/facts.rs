//! Native-valued facts for real snapshot reads: no FX and both physical stable orientations.

use binsight_core::units::{Decimals, Lamports};
use binsight_engine::portfolio::WalletLabel;
use binsight_engine::portfolio::views::{SyncState, WalletColor, WalletSync};
use binsight_engine::portfolio::{SnapshotFacts, TrackedWallet};
use binsight_ledger::facts::*;
use binsight_ledger::report::figure::Figure;
use binsight_solana::{Address, Signature};
use jiff::Timestamp;

pub(crate) fn id(byte: u8) -> PositionId {
    PositionId {
        address: Address::from_bytes([byte; 32]),
        opened_by: Signature::from_bytes([byte; 64]),
    }
}

fn token(byte: u8, kind: TokenKind) -> TokenFacts {
    TokenFacts {
        mint: Address::from_bytes([byte; 32]),
        symbol: None,
        name: None,
        decimals: if kind == TokenKind::Sol {
            Decimals::SOL
        } else {
            Decimals(6)
        },
        kind,
    }
}

fn pool(byte: u8, kinds: (TokenKind, TokenKind)) -> PoolFacts {
    PoolFacts {
        address: Address::from_bytes([byte; 32]),
        bin_step: 100,
        base: token(byte.checked_mul(2).unwrap(), kinds.0),
        quote: token(
            byte.checked_mul(2).unwrap().checked_add(1).unwrap(),
            kinds.1,
        ),
    }
}

fn wallet(now: Timestamp) -> TrackedWallet {
    let address = Address::from_bytes([9; 32]);
    TrackedWallet {
        facts: WalletFacts {
            address,
            added_at: Timestamp::UNIX_EPOCH,
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

fn open(byte: u8, pool: u8, now: Timestamp) -> OpenPositionFacts {
    OpenPositionFacts {
        id: id(byte),
        wallet: Address::from_bytes([9; 32]),
        pool: Address::from_bytes([pool; 32]),
        strategy: Some(Strategy::Spot),
        opened_at: Timestamp::UNIX_EPOCH,
        invested: QuoteUnits(100_000_000),
        withdrawn: QuoteUnits(0),
        claimed_fees: QuoteUnits(0),
        rewards: QuoteUnits(0),
        unpriced_rewards: 0,
        // These are already-valued facts, not a bin-price calculation fixture.
        value: Figure::Complete(QuoteUnits(620_000_000)),
        unclaimed_fees: Figure::Complete(QuoteUnits(0)),
        unclaimed_fee_presence: Some(false),
        lower_bin_id: 0,
        upper_bin_id: 2,
        active_bin_id: 1,
        bins: vec![],
        range_since: None,
        valued_at: now,
        unpriced_movements: 0,
        unpriced_rebalances: 0,
    }
}

fn closed(byte: u8, pool: u8, method: PnlMethod, now: Timestamp) -> ClosedPositionFacts {
    ClosedPositionFacts {
        id: id(byte),
        wallet: Address::from_bytes([9; 32]),
        pool: Address::from_bytes([pool; 32]),
        strategy: Some(Strategy::Spot),
        opened_at: Timestamp::UNIX_EPOCH,
        closed_at: now,
        invested: QuoteUnits(100_000_000),
        withdrawn: QuoteUnits(110_000_000),
        claimed_fees: QuoteUnits(0),
        rewards: QuoteUnits(0),
        unpriced_rewards: 0,
        method,
        unpriced_movements: 0,
        unpriced_rebalances: 0,
    }
}

pub(super) fn facts(now: Timestamp) -> SnapshotFacts {
    SnapshotFacts {
        pools: vec![
            pool(3, (TokenKind::Usdc, TokenKind::Sol)),
            pool(4, (TokenKind::Sol, TokenKind::Usdc)),
            pool(5, (TokenKind::Other, TokenKind::Other)),
            pool(6, (TokenKind::Other, TokenKind::Sol)),
        ],
        wallets: vec![wallet(now)],
        open: vec![
            open(1, 3, now),
            open(2, 4, now),
            open(7, 5, now),
            open(8, 6, now),
        ],
        closed: vec![
            closed(10, 3, PnlMethod::Pool, now),
            closed(
                11,
                4,
                PnlMethod::Fifo {
                    market_pnl: QuoteUnits(-7_000_000),
                },
                now,
            ),
            closed(12, 5, PnlMethod::Pool, now),
        ],
        ..SnapshotFacts::default()
    }
}
