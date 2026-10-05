//! A bridge starts at the requested instant, even when the last mark is earlier.

use super::*;
use binsight_core::money::SignedLamports;
use binsight_ledger::facts::{OpenPnlMark, WalletEntry, WalletEntryKind};
use binsight_ledger::report::valued::Valued as ValuedAmounts;

#[test]
fn excludes_an_entry_between_the_last_mark_and_the_start_of_the_window() {
    let mut world = wallet_world(7);
    world.wallet.added_at = jiff::Timestamp::UNIX_EPOCH;
    world.closed.clear();
    world.open.clear();
    world.entries = vec![WalletEntry {
        wallet: world.wallet.address,
        at: common::at(40_500),
        kind: WalletEntryKind::NetworkFee,
        amount: SignedLamports(-2),
        signature: None,
    }];
    world.marks = vec![OpenPnlMark {
        wallet: world.wallet.address,
        at: common::at(39_600),
        open_pnl: Figure::Complete(SignedLamports::ZERO),
    }];
    let valued = value(&world);
    let window = Window {
        scope: binsight_ledger::report::period::WindowScope::Period(Period::Today),
        start: common::at(41_400),
        end: common::at(43_200),
    };
    let point = valued.history.point_at(window.start, &world.rates).unwrap();
    assert_eq!(
        point.real_pnl.value().unwrap().sol,
        Some(SignedLamports(-2))
    );
    let entries: Vec<_> = world.entries.iter().collect();
    let wallets = [&valued.history];
    let result = bridge(
        BridgeFacts {
            wallets: &wallets,
            closed: &[],
            entries: &entries,
            open: &[],
            rates: &world.rates,
        },
        &window,
        &Figure::Complete(ValuedAmounts::ZERO),
    )
    .unwrap();
    assert!(
        result
            .legs
            .iter()
            .all(|leg| leg.amount.value().unwrap().sol == Some(SignedLamports::ZERO))
    );
}
