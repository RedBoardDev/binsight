//! Chain mode serves what the engine knows, read from a running engine.

use std::time::Duration;

use binsight_solana::Address;

use crate::engine::events::EngineEvent;
use crate::portfolio::scope::Scope;
use crate::portfolio::views::{InstanceSettings, SyncState};
use crate::portfolio::{ReadError, ReadModel};
use crate::test_support::{RunningEngine, TEST_START, complete_history, expect_nothing_new};
use binsight_ledger::report::valued::Currency;

const WALLET: Address = Address::from_bytes([1; 32]);

#[tokio::test(start_paused = true)]
async fn serves_the_wallets_their_sync_and_the_settings_of_a_running_engine() {
    let setup = complete_history(&[WALLET], 2_000).await;
    expect_nothing_new(&setup.transport, WALLET, 2_000);
    let handle = setup.handle.clone();
    let mut events = handle.subscribe();
    let engine = RunningEngine::start(setup);
    loop {
        let event = tokio::time::timeout(Duration::from_secs(3_600), events.recv())
            .await
            .unwrap()
            .unwrap();
        if matches!(event, EngineEvent::WalletSyncChanged { .. }) {
            break;
        }
    }
    let portfolio: &dyn ReadModel = handle.read_model();

    let sync = portfolio.sync_report().await.unwrap();
    let wallets = portfolio.wallets(Currency::Sol).await.unwrap();

    assert_eq!(sync.state, SyncState::Live);
    assert_eq!(sync.wallets.len(), 1);
    let line = &sync.wallets[0];
    assert_eq!(line.wallet.address, WALLET);
    assert_eq!(
        (line.sync.indexed_tx, line.sync.last_tx_at),
        (1, Some(TEST_START))
    );
    assert_eq!(sync.credits.budget, 1_000_000);
    assert_eq!(wallets.items[0].sync, line.sync);
    assert_eq!(wallets.items[0].positions, None);
    assert_eq!(
        portfolio.settings().await.unwrap(),
        InstanceSettings::default()
    );
    assert_eq!(
        portfolio.recent_closes(Scope::All, Currency::Sol).await,
        Err(ReadError::NotReady)
    );
    engine.stop().await;
}

#[tokio::test]
async fn serves_the_sync_report_and_the_wallets_from_what_the_engine_published() {
    use std::sync::Arc;

    use binsight_chain::test_support::{ScriptedTransport, scripted_client};
    use binsight_core::clock::FixedClock;
    use binsight_store::{
        Store, TrackedWallet, WalletBacklog, WalletCursor, WalletListing, WalletProgress,
    };
    use tokio::sync::watch;

    use crate::engine::status::EngineStatus;
    use crate::ingestion::WalletStatus;
    use crate::portfolio::{ChainPortfolio, EngineState};

    // A file with no schema: any read of the database fails, so the answers below can only
    // come from what the engine published.
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("binsight.db");
    std::fs::File::create(&path).unwrap();
    let store = Store::open_existing(&path).await.unwrap();
    let clock = Arc::new(FixedClock::new(TEST_START));
    let status = WalletStatus {
        progress: WalletProgress {
            wallet: TrackedWallet {
                address: WALLET,
                added_at: TEST_START,
                cursor: WalletCursor::NotStarted,
            },
            backlog: WalletBacklog::default(),
            listing: WalletListing {
                listed: 3,
                newest_block_time: Some(TEST_START),
            },
        },
        state: SyncState::Live,
    };
    let portfolio = ChainPortfolio::new(EngineState {
        store,
        rpc: scripted_client(ScriptedTransport::new(), clock.clone(), None),
        clock,
        status: watch::channel(EngineStatus::Running).1,
        sync_statuses: watch::channel(Some(Arc::new(vec![status]))).1,
        failed_decodes: watch::channel(Some(2)).1,
    });
    let portfolio: &dyn ReadModel = &portfolio;

    let sync = portfolio.sync_report().await.unwrap();
    let wallets = portfolio.wallets(Currency::Sol).await.unwrap();

    assert_eq!(sync.failed_decodes, 2);
    assert_eq!(sync.state, SyncState::Live);
    assert_eq!(sync.wallets[0].sync.indexed_tx, 3);
    assert_eq!(wallets.items[0].wallet.address, WALLET);
}
