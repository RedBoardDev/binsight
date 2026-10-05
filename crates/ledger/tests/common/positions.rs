//! A known owned Token-2022 position and its exact gross transfer, net event and tax.
use super::*;
use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::{MovementKind, PositionMovement, TxActivity};
use binsight_ledger::book::WalletContext;
use binsight_solana::{
    programs::TokenProgram,
    transaction::{InstructionPosition, TransactionView},
    well_known::TOKEN_2022_PROGRAM,
};

#[expect(
    clippy::indexing_slicing,
    reason = "test instruction layout has nine known accounts"
)]
pub(crate) fn deposit() -> (WalletContext, TransactionView, TxActivity) {
    let mut tx = transaction(1_000_000, 995_000);
    let position = address(11);
    let pool = address(12);
    let mint = address(9);
    let mut accounts = vec![address(0); 9];
    accounts[0] = position;
    accounts[1] = pool;
    accounts[7] = mint;
    accounts[8] = address(8);
    tx.instructions.push(instruction(
        binsight_dlmm::program::PROGRAM_ID,
        accounts,
        0xe4a2_4e1c_46db_7473_u64.to_be_bytes().to_vec(),
    ));
    tx.token_balances = vec![
        token(address(2), address(1), mint, 1_000, 0),
        token(address(3), pool, mint, 0, 950),
        token(address(4), pool, address(8), 0, 0),
    ];
    tx.token_balances[0].program = TokenProgram::Token2022;
    tx.token_balances[1].program = TokenProgram::Token2022;
    tx.native_balances.push(native(address(2), 200, 200));
    let mut bytes = vec![26, 1];
    bytes.extend(1_000_u64.to_le_bytes());
    bytes.push(6);
    bytes.extend(50_u64.to_le_bytes());
    tx.instructions.push(instruction(
        TOKEN_2022_PROGRAM,
        vec![address(2), mint, address(3), address(1)],
        bytes,
    ));
    tx.instructions[1].position.inner = Some(0);
    tx.instructions[1].stack_height = Some(2);
    let mut wallet = WalletContext::new(address(1));
    wallet.positions.insert(position);
    let activity = TxActivity {
        movements: vec![PositionMovement {
            at: InstructionPosition {
                top: 0,
                inner: None,
            },
            position,
            pool,
            kind: MovementKind::Deposit,
            x: RawTokenAmount(950),
            y: RawTokenAmount(0),
            price_bin: Some(0),
        }],
        ..TxActivity::default()
    };
    (wallet, tx, activity)
}
