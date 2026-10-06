//! A position's rent is the wallet's only when the wallet paid it.
#[path = "common/fold.rs"]
mod common;

use binsight_dlmm::program::PROGRAM_ID;
use binsight_ledger::book::{Asset, EntryKind, RentPayer};
use binsight_solana::Address;
use binsight_solana::well_known::SYSTEM_PROGRAM;
use common::*;

/// The automation that pays a position's rent for its owner.
const AUTOMATION: Address = Address::from_bytes([30; 32]);

/// The `close_position2` discriminator: the position, its sender and the rent receiver.
const CLOSE_POSITION2: u64 = 0xae5a_2373_ba28_93e2;

/// The rent of a position account, in lamports.
const RENT: u64 = 70_000_000;

/// The automation creates the wallet's position and pays its 70,000,000 lamports of rent; the
/// wallet later closes it with itself as the rent receiver. The lock was never the wallet's, so
/// the release is not either: the lamports the wallet receives are a gain of 70,000,000.
#[test]
fn books_rent_an_automation_paid_and_the_wallet_receives_as_a_gain() {
    let mut fold = fold();
    let creation = lifecycle(vec![created(POSITION, SOL_POOL, WALLET)]);
    let mut create = step(1, 1, &creation);
    let mut data = 0_u32.to_le_bytes().to_vec();
    data.extend(RENT.to_le_bytes());
    data.extend(8_120_u64.to_le_bytes());
    data.extend(PROGRAM_ID.as_bytes());
    create.instructions.push(book::instruction(
        SYSTEM_PROGRAM,
        vec![AUTOMATION, POSITION],
        data,
    ));
    create.native_balances.push(book::native(POSITION, 0, RENT));
    let created_entries = fold.book(&create, &creation, &pools()).unwrap().entries;
    assert!(
        created_entries
            .iter()
            .all(|entry| entry.asset != Asset::Rent)
    );
    let life = fold.open().next().unwrap();
    assert_eq!(life.rent_payer, Some(RentPayer::Other));

    let closing = lifecycle(vec![closed(POSITION, WALLET)]);
    let mut close = step(2, 2, &closing);
    if let Some(wallet) = close.native_balances.first_mut() {
        wallet.post.0 = 995_000 + RENT;
    }
    close.native_balances.push(book::native(POSITION, RENT, 0));
    close.instructions.push(book::instruction(
        PROGRAM_ID,
        vec![POSITION, WALLET, WALLET],
        CLOSE_POSITION2.to_be_bytes().to_vec(),
    ));
    let entries = fold.book(&close, &closing, &pools()).unwrap().entries;
    assert!(entries.iter().all(|entry| entry.asset != Asset::Rent));
    let gain: i128 = entries
        .iter()
        .filter(|entry| entry.asset == Asset::Sol && entry.kind != EntryKind::NetworkFee)
        .map(|entry| entry.amount)
        .sum();
    assert_eq!(gain, i128::from(RENT));
    assert!(entries.iter().any(|entry| entry.amount == i128::from(RENT)
        && entry.kind
            == EntryKind::ProtocolActivity {
                program: PROGRAM_ID
            }));
}
