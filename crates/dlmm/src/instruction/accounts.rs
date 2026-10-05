//! The accounts through which some DLMM instructions name their pool's tokens, or the bin array
//! they create.
//!
//! The events of the program give amounts of token X and token Y, never the tokens themselves:
//! the instructions name them among their accounts, at a place fixed by the program's IDL
//! (`lb_clmm` 0.12.0). Instructions that move both tokens name both mints; the one-sided
//! deposits name only the token they move. This module reads those places; it does not decide
//! which token an event moved (see [`crate::pool_tokens`]).

use binsight_solana::Address;
use binsight_solana::transaction::InstructionNode;

use super::instruction_name;

/// Where an instruction names its pool and the tokens it moves.
#[derive(Clone, Copy)]
enum TokenAccounts {
    /// The pool and both of its mints.
    Both {
        pool: usize,
        mint_x: usize,
        mint_y: usize,
    },
    /// The pool and the mint of the one token the instruction moves.
    OneSide { pool: usize, mint: usize },
}

/// The instructions that name their pool's tokens, by IDL name.
const TOKEN_ACCOUNTS: [(&str, TokenAccounts); 26] = [
    ("add_liquidity", BOTH_AFTER_THE_POSITION),
    ("add_liquidity2", BOTH_AFTER_THE_POSITION),
    ("add_liquidity_by_strategy", BOTH_AFTER_THE_POSITION),
    ("add_liquidity_by_strategy2", BOTH_AFTER_THE_POSITION),
    ("add_liquidity_by_weight", BOTH_AFTER_THE_POSITION),
    ("add_liquidity_by_weight2", BOTH_AFTER_THE_POSITION),
    ("add_liquidity_by_strategy_one_side", ONE_SIDE_DEPOSIT),
    ("add_liquidity_one_side", ONE_SIDE_DEPOSIT),
    ("add_liquidity_one_side_precise", ONE_SIDE_DEPOSIT),
    ("add_liquidity_one_side_precise2", ONE_SIDE_DEPOSIT),
    ("remove_all_liquidity", BOTH_AFTER_THE_POSITION),
    ("remove_liquidity", BOTH_AFTER_THE_POSITION),
    ("remove_liquidity2", BOTH_AFTER_THE_POSITION),
    ("remove_liquidity_by_range", BOTH_AFTER_THE_POSITION),
    ("remove_liquidity_by_range2", BOTH_AFTER_THE_POSITION),
    ("rebalance_liquidity", BOTH_AFTER_THE_POSITION),
    (
        "claim_fee",
        TokenAccounts::Both {
            pool: 0,
            mint_x: 9,
            mint_y: 10,
        },
    ),
    (
        "claim_fee2",
        TokenAccounts::Both {
            pool: 0,
            mint_x: 7,
            mint_y: 8,
        },
    ),
    ("swap", BOTH_OF_A_SWAP),
    ("swap2", BOTH_OF_A_SWAP),
    ("swap_exact_out", BOTH_OF_A_SWAP),
    ("swap_exact_out2", BOTH_OF_A_SWAP),
    ("swap_with_price_impact", BOTH_OF_A_SWAP),
    ("swap_with_price_impact2", BOTH_OF_A_SWAP),
    (
        "cancel_limit_order",
        TokenAccounts::Both {
            pool: 0,
            mint_x: 4,
            mint_y: 5,
        },
    ),
    (
        "place_limit_order",
        TokenAccounts::OneSide { pool: 0, mint: 3 },
    ),
];

/// The liquidity instructions: the position, the pool, then accounts up to both mints.
const BOTH_AFTER_THE_POSITION: TokenAccounts = TokenAccounts::Both {
    pool: 1,
    mint_x: 7,
    mint_y: 8,
};

/// The one-sided deposits: the position, the pool, then accounts up to the mint deposited.
const ONE_SIDE_DEPOSIT: TokenAccounts = TokenAccounts::OneSide { pool: 1, mint: 5 };

/// The swaps: the pool first, then accounts up to both mints.
const BOTH_OF_A_SWAP: TokenAccounts = TokenAccounts::Both {
    pool: 0,
    mint_x: 6,
    mint_y: 7,
};

/// The pool tokens an instruction names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamedTokens {
    /// Both tokens, in their pool's order.
    Both {
        /// The pool.
        pool: Address,
        /// The mint of token X.
        mint_x: Address,
        /// The mint of token Y.
        mint_y: Address,
    },
    /// The one token the instruction moves, without saying whether it is X or Y.
    OneSide {
        /// The pool.
        pool: Address,
        /// The mint moved.
        mint: Address,
    },
}

/// The pool tokens `instruction` names, if it is a DLMM instruction that names them.
pub fn named_tokens(instruction: &InstructionNode) -> Option<NamedTokens> {
    let name = instruction_name(instruction)?;
    let (_, layout) = TOKEN_ACCOUNTS.iter().find(|(known, _)| *known == name)?;
    let account = |index: usize| instruction.accounts.get(index).copied();
    match *layout {
        TokenAccounts::Both {
            pool,
            mint_x,
            mint_y,
        } => Some(NamedTokens::Both {
            pool: account(pool)?,
            mint_x: account(mint_x)?,
            mint_y: account(mint_y)?,
        }),
        TokenAccounts::OneSide { pool, mint } => Some(NamedTokens::OneSide {
            pool: account(pool)?,
            mint: account(mint)?,
        }),
    }
}

/// The bin array `initialize_bin_array` creates (its second account) and who pays its rent (its
/// third).
const BIN_ARRAY_ACCOUNT: usize = 1;
const BIN_ARRAY_FUNDER_ACCOUNT: usize = 2;

/// A bin array created by `initialize_bin_array`: the account holding a range of a pool's bins,
/// whose rent the funder pays and does not get back while the pool lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BinArrayFunding {
    /// The bin array.
    pub bin_array: Address,
    /// Who pays its rent.
    pub funder: Address,
}

/// The bin array `instruction` creates, if it is an `initialize_bin_array` call.
pub fn bin_array_funding(instruction: &InstructionNode) -> Option<BinArrayFunding> {
    if instruction_name(instruction)? != "initialize_bin_array" {
        return None;
    }
    Some(BinArrayFunding {
        bin_array: *instruction.accounts.get(BIN_ARRAY_ACCOUNT)?,
        funder: *instruction.accounts.get(BIN_ARRAY_FUNDER_ACCOUNT)?,
    })
}

/// The position and rent recipient named by a position-close instruction.
pub fn position_rent_receiver(instruction: &InstructionNode) -> Option<(Address, Address)> {
    let receiver = match instruction_name(instruction)? {
        "close_position" => 5,
        "close_position2" | "close_position_if_empty" => 2,
        _ => return None,
    };
    Some((
        *instruction.accounts.first()?,
        *instruction.accounts.get(receiver)?,
    ))
}
