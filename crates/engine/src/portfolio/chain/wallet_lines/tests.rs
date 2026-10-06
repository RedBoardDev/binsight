//! The sync line and row of a wallet, from what the engine knows of it.

use binsight_solana::Signature;
use binsight_store::ListedTop;
use jiff::SignedDuration;

use super::*;

const WALLET: Address = Address::from_bytes([1; 32]);

fn now() -> Timestamp {
    Timestamp::from_second(1_790_000_000).unwrap()
}

fn facts(state: Option<ingestion::SyncState>, cursor: WalletCursor) -> WalletFacts {
    WalletFacts {
        wallet: TrackedWallet {
            address: WALLET,
            added_at: now(),
            cursor,
        },
        position: 9,
        state,
        backlog: WalletBacklog {
            unfetched: 25,
            history_unfetched: 25,
            ..WalletBacklog::default()
        },
        listing: WalletListing {
            listed: 100,
            newest_block_time: Some(now()),
        },
    }
}

fn listed() -> WalletCursor {
    WalletCursor::HistoryComplete {
        top: Some(ListedTop {
            signature: Signature::from_bytes([2; 64]),
            slot: 7,
        }),
    }
}

#[test]
fn shows_an_import_with_its_progress_once_the_history_is_listed() {
    let line = sync_line(
        &facts(Some(ingestion::SyncState::Importing), listed()),
        now(),
    );

    assert_eq!(line.sync.state, SyncState::Importing);
    assert_eq!(line.sync.indexed_tx, 75);
    assert_eq!(line.sync.last_tx_at, Some(now()));
    let import = line.sync.import.unwrap();
    assert_eq!(import.progress, Some(Percent::of(75, 100).unwrap()));
    assert_eq!(import.eta_seconds, None);
    assert_eq!(line.wallet.label, WalletLabel::short_address(&WALLET));
    assert_eq!(line.wallet.color, WalletColor::Wallet2);
}

#[test]
fn has_no_progress_while_the_history_is_still_listed() {
    let line = sync_line(&facts(None, WalletCursor::NotStarted), now());

    assert_eq!(line.sync.state, SyncState::Importing);
    assert_eq!(line.sync.import.unwrap().progress, None);
}

#[test]
fn says_how_long_live_work_has_waited_while_it_lags() {
    let mut lagging = facts(Some(ingestion::SyncState::Lagging), listed());
    lagging.backlog.oldest_live_due_at = now().checked_sub(SignedDuration::from_secs(150)).ok();
    let live = facts(Some(ingestion::SyncState::Live), listed());

    assert_eq!(sync_line(&lagging, now()).sync.lag_seconds, Some(150));
    assert_eq!(sync_line(&live, now()).sync.lag_seconds, Some(0));
    assert_eq!(sync_line(&live, now()).sync.import, None);
}

#[test]
fn leaves_the_figures_unavailable_and_the_positions_uncounted() {
    let importing = sync_line(&facts(None, listed()), now());
    let live = sync_line(&facts(Some(ingestion::SyncState::Live), listed()), now());

    let row = summary(&importing, now());
    let expected = Reasons::from([Reason::HistoryIncomplete {
        wallet: WALLET,
        progress: Some(Percent::of(75, 100).unwrap()),
    }]);
    assert_eq!(
        row.net_worth,
        Figure::Unavailable {
            reasons: expected.clone()
        }
    );
    assert_eq!(row.positions, None);
    assert_eq!(
        summary(&live, now()).real_pnl,
        Figure::Unavailable {
            reasons: Reasons::new()
        }
    );
    let sum = total([&importing, &live]);
    assert_eq!(sum.net_worth, Figure::Unavailable { reasons: expected });
    assert_eq!(sum.positions, None);
}
