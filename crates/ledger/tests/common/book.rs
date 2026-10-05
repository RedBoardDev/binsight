//! Public-fixture and synthetic transactions used by transaction accounting tests.
#![allow(
    dead_code,
    reason = "each test binary uses a different subset of these builders"
)]

#[path = "positions.rs"]
pub(crate) mod positions;

use binsight_core::units::{Decimals, Lamports, RawTokenAmount};
use binsight_solana::programs::TokenProgram;
use binsight_solana::transaction::{
    FeeBreakdown, InstructionData, InstructionNode, InstructionPosition, NativeBalance,
    TokenBalance, TransactionView, TxOutcome, TxVersion,
};
use binsight_solana::well_known::SYSTEM_PROGRAM;
use binsight_solana::{Address, Signature};

pub(crate) fn address(byte: u8) -> Address {
    Address::from_bytes([byte; 32])
}

pub(crate) fn native(account: Address, pre: u64, post: u64) -> NativeBalance {
    NativeBalance {
        account,
        pre: Lamports(pre),
        post: Lamports(post),
    }
}

pub(crate) fn transaction(pre: u64, post: u64) -> TransactionView {
    TransactionView {
        signature: Signature::from_bytes([1; 64]),
        slot: 1,
        block_time: None,
        transaction_index: Some(0),
        version: TxVersion::Legacy,
        outcome: TxOutcome::Succeeded,
        fee_payer: address(1),
        fee: FeeBreakdown {
            total: Lamports(5_000),
            base: Lamports(5_000),
            priority: Lamports(0),
        },
        accounts: vec![binsight_solana::transaction::AccountKey {
            address: address(1),
            is_signer: true,
            is_writable: true,
            source: binsight_solana::transaction::AccountSource::Message,
        }],
        instructions: Vec::new(),
        native_balances: vec![native(address(1), pre, post)],
        token_balances: Vec::new(),
    }
}

pub(crate) fn instruction(
    program: Address,
    accounts: Vec<Address>,
    data: Vec<u8>,
) -> InstructionNode {
    InstructionNode {
        program,
        accounts,
        data: InstructionData(data),
        stack_height: Some(1),
        position: InstructionPosition {
            top: 0,
            inner: None,
        },
    }
}

pub(crate) fn transfer(from: Address, to: Address, lamports: u64) -> InstructionNode {
    let mut bytes = 2_u32.to_le_bytes().to_vec();
    bytes.extend(lamports.to_le_bytes());
    instruction(SYSTEM_PROGRAM, vec![from, to], bytes)
}

pub(crate) fn token(
    account: Address,
    owner: Address,
    mint: Address,
    pre: u128,
    post: u128,
) -> TokenBalance {
    TokenBalance {
        account,
        mint,
        program: TokenProgram::Token,
        decimals: Decimals(6),
        owner_pre: Some(owner),
        owner_post: Some(owner),
        pre: RawTokenAmount(pre),
        post: RawTokenAmount(post),
    }
}
