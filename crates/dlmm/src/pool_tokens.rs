//! Which tokens the X and Y amounts of a position movement are.
//!
//! The events give amounts of a pool's token X and token Y; the mints are named by the
//! instructions of the same transaction (see [`crate::instruction::named_tokens`]). A pool's two
//! mints come from any instruction that names both. A one-sided deposit names only the token it
//! moves: that token is the side of its movement that is not zero. A mint is trusted only when
//! one of the pool's own token accounts (its reserves, owned by the pool) holds it in the
//! transaction, so a misread account can never pass for a token. This module resolves mints; it
//! does not decide whose movement it is.

use binsight_solana::Address;
use binsight_solana::transaction::{InstructionPosition, TransactionView};

use crate::activity::PositionMovement;
use crate::activity::emitter;
use crate::instruction::{NamedTokens, named_tokens};

/// The pool tokens the instructions of one transaction name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PoolTokens {
    /// Pools whose two mints an instruction names: `(pool, mint_x, mint_y)`.
    pairs: Vec<(Address, Address, Address)>,
    /// One-sided deposits: the instruction, its pool and the mint it moves.
    one_sides: Vec<(InstructionPosition, Address, Address)>,
}

/// The mints of the two amounts of a movement, when the transaction says them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MovementMints {
    /// The mint of token X.
    pub x: Option<Address>,
    /// The mint of token Y.
    pub y: Option<Address>,
}

impl PoolTokens {
    /// The pool tokens named by the instructions of `tx`, kept only when the pool's reserves hold
    /// them.
    pub fn of(tx: &TransactionView) -> Self {
        let mut tokens = Self::default();
        for instruction in &tx.instructions {
            match named_tokens(instruction) {
                Some(NamedTokens::Both {
                    pool,
                    mint_x,
                    mint_y,
                }) if holds(tx, pool, mint_x) && holds(tx, pool, mint_y) => {
                    tokens.pairs.push((pool, mint_x, mint_y));
                }
                Some(NamedTokens::OneSide { pool, mint }) if holds(tx, pool, mint) => {
                    tokens.one_sides.push((instruction.position, pool, mint));
                }
                Some(_) | None => {}
            }
        }
        tokens
    }

    /// The mints of the amounts of `movement`, a movement of `tx`.
    pub fn mints_of(&self, tx: &TransactionView, movement: &PositionMovement) -> MovementMints {
        if let Some((mint_x, mint_y)) = self.pair_of(movement.pool) {
            return MovementMints {
                x: Some(mint_x),
                y: Some(mint_y),
            };
        }
        let Some(mint) = self.one_side_mint(tx, movement) else {
            return MovementMints::default();
        };
        match (movement.x.0 > 0, movement.y.0 > 0) {
            (true, false) => MovementMints {
                x: Some(mint),
                y: None,
            },
            (false, true) => MovementMints {
                x: None,
                y: Some(mint),
            },
            _ => MovementMints::default(),
        }
    }

    /// The two mints of `pool`, when the instructions that name them agree.
    fn pair_of(&self, pool: Address) -> Option<(Address, Address)> {
        let mut named = self
            .pairs
            .iter()
            .filter(|(named_pool, ..)| *named_pool == pool)
            .map(|&(_, mint_x, mint_y)| (mint_x, mint_y));
        let first = named.next()?;
        named.all(|other| other == first).then_some(first)
    }

    /// The mint of the one-sided deposit that emitted `movement`: its emitter, or else the only
    /// one-sided deposit of its pool in the transaction.
    fn one_side_mint(&self, tx: &TransactionView, movement: &PositionMovement) -> Option<Address> {
        let of_pool = || {
            self.one_sides
                .iter()
                .filter(|(_, pool, _)| *pool == movement.pool)
        };
        if let Some(emitter) = emitter::emitter(tx, movement.at) {
            return of_pool()
                .find(|(at, ..)| *at == emitter.position)
                .map(|&(.., mint)| mint);
        }
        let mut candidates = of_pool();
        let (.., mint) = *candidates.next()?;
        candidates.next().is_none().then_some(mint)
    }
}

/// Whether a token account owned by `pool` (one of its reserves) holds `mint` in `tx`.
fn holds(tx: &TransactionView, pool: Address, mint: Address) -> bool {
    tx.token_balances.iter().any(|balance| {
        balance.mint == mint
            && (balance.owner_pre == Some(pool) || balance.owner_post == Some(pool))
    })
}
