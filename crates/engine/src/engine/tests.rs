//! The engine's lifecycle on a temporary database: its statuses, its stop, and a restart that
//! fetches nothing twice.

use binsight_solana::Address;

use super::*;
use crate::engine::health::ComponentHealth;
use binsight_chain::SIGNATURE_PAGE_LIMIT;
use binsight_chain::test_support::ScriptedReply;
use serde_json::json;

use crate::test_support::{
    RunningEngine, TEST_START, expect_nothing_new, expect_transactions, numbered_signature,
    reopened_engine, signature_page, temporary_engine,
};

#[tokio::test]
async fn moves_from_starting_to_running_to_stopping() {
    let setup = temporary_engine().await;
    let handle = setup.handle;
    let mut events = handle.subscribe();
    let shutdown = CancellationToken::new();
    assert_eq!(handle.status(), EngineStatus::Starting);

    let task = tokio::spawn(setup.engine.run(shutdown.clone()));
    let running = events.recv().await.unwrap();
    assert_eq!(handle.status(), EngineStatus::Running);
    shutdown.cancel();
    task.await.unwrap().unwrap();
    let stopping = events.recv().await.unwrap();

    assert_eq!(
        running,
        EngineEvent::StatusChanged {
            status: EngineStatus::Running
        }
    );
    assert_eq!(
        stopping,
        EngineEvent::StatusChanged {
            status: EngineStatus::Stopping
        }
    );
    assert_eq!(handle.status(), EngineStatus::Stopping);
}

#[tokio::test]
async fn returns_as_soon_as_the_shutdown_is_requested() {
    let setup = temporary_engine().await;
    let shutdown = CancellationToken::new();
    shutdown.cancel();

    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        setup.engine.run(shutdown),
    )
    .await
    .unwrap()
    .unwrap();
}

#[tokio::test]
async fn reports_a_working_database_as_healthy() {
    let setup = temporary_engine().await;

    let health = setup.handle.health().await;

    assert_eq!(health.database, ComponentHealth::Ok);
    assert_eq!(health.engine, EngineStatus::Starting);
}

#[tokio::test(start_paused = true)]
async fn makes_no_network_call_when_no_wallet_is_tracked() {
    let engine = RunningEngine::start(temporary_engine().await);

    tokio::time::sleep(std::time::Duration::from_secs(600)).await;

    assert_eq!(engine.transport.calls(), Vec::new());
    assert_eq!(engine.stream.connections_opened(), 0);
    engine.stop().await;
}

#[tokio::test(start_paused = true)]
async fn resumes_after_a_restart_with_one_top_up_and_nothing_fetched_again() {
    let wallet = Address::from_bytes([1; 32]);
    let setup = temporary_engine().await;
    setup.store.wallets().add(wallet, TEST_START).await.unwrap();
    for _listing_and_its_confirmation in 0..2 {
        let listing = setup.transport.expect("getSignaturesForAddress");
        listing.respond(signature_page(0, 3));
    }
    expect_transactions(&setup.transport, 3);
    let engine = RunningEngine::start(setup);
    engine.wait_for_complete_history(wallet).await;
    engine
        .wait_for_counts(wallet, |counts| counts.fetched == 3)
        .await;
    let folder = engine.stop().await;

    let setup = reopened_engine(folder).await;
    expect_nothing_new(&setup.transport, wallet, 0);
    let restarted = RunningEngine::start(setup);
    tokio::time::sleep(std::time::Duration::from_secs(600)).await;

    assert_eq!(restarted.transport.calls().len(), 1);
    restarted.stop().await;
}

#[tokio::test(start_paused = true)]
async fn resumes_an_interrupted_history_from_the_last_written_page() {
    let wallet = Address::from_bytes([1; 32]);
    let full = u16::try_from(SIGNATURE_PAGE_LIMIT).unwrap();
    let setup = temporary_engine().await;
    setup.store.wallets().add(wallet, TEST_START).await.unwrap();
    let transport = &setup.transport;
    transport
        .expect("getSignaturesForAddress")
        .respond(signature_page(0, full));
    transport
        .expect("getSignaturesForAddress")
        .respond(ScriptedReply::Result(json!("not a page")));
    expect_transactions(transport, SIGNATURE_PAGE_LIMIT);
    let engine = RunningEngine::start(setup);
    while engine.transport.calls().len() < 2 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let interrupted = engine.store.fetch_queue().counts(wallet).await.unwrap();
    let folder = engine.stop().await;

    let setup = reopened_engine(folder).await;
    let below_first_page = json!([
        wallet.to_string(),
        {"limit": 1_000, "commitment": "finalized",
         "before": numbered_signature(full - 1).to_string()}
    ]);
    for _listing_and_its_confirmation in 0..2 {
        setup
            .transport
            .expect("getSignaturesForAddress")
            .with_params(below_first_page.clone())
            .respond(signature_page(full, 2));
    }
    expect_nothing_new(&setup.transport, wallet, 0);
    let unfetched = usize::try_from(interrupted.listed - interrupted.fetched).unwrap();
    expect_transactions(&setup.transport, unfetched + 2);
    let restarted = RunningEngine::start(setup);
    restarted.wait_for_complete_history(wallet).await;
    let counts = restarted
        .wait_for_counts(wallet, |counts| counts.fetched == 1_002)
        .await;

    assert_eq!(interrupted.listed, 1_000);
    assert_eq!(counts.listed, 1_002);
    restarted.stop().await;
}
