//! Named contradictions and unavailable lifetime evidence; neither is silently foreign ownership.

use binsight_solana::transaction::InstructionPosition;
use binsight_solana::{Address, Signature};

use crate::facts::PositionId;

/// Evidence required for a life or its facts is unavailable, while other sources remain usable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifetimeDiagnostic {
    /// A position is touched without a known creation; its owner and identity are unresolved.
    MissingCreation {
        /// The position account.
        position: Address,
        /// The transaction that exposed the gap.
        signature: Signature,
    },
    /// A required lifecycle or movement timestamp is absent, never replaced with the epoch.
    MissingBlockTime {
        /// The transaction missing its block time.
        signature: Signature,
    },
    /// A transaction has no proved within-slot order.
    MissingTransactionOrder {
        /// The transaction missing the proof.
        signature: Signature,
    },
    /// Dates cannot prove coverage of this lifetime, independently of chain ordering.
    InconsistentLifetimeDates {
        /// The life whose dates do not fit the replay observation interval.
        position: PositionId,
    },
    /// The adapter could not establish a contiguous set of actually available sources.
    NoncontiguousSources,
    /// Unknown DLMM activity prevents announcing that all position effects are understood.
    UnknownProgramActivity {
        /// The transaction containing unknown activity.
        signature: Signature,
    },
}

/// A contradiction refuses the transaction without partially mutating the replay.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LifetimeError {
    /// A source belongs to a different wallet.
    #[error("the position source belongs to another wallet")]
    WrongWallet,
    /// A supplied canonical proof does not equal the original parsed index.
    #[error("the canonical position source index contradicts the transaction")]
    CanonicalIndexMismatch,
    /// Sources are not strictly chronological in their uniform order space.
    #[error("the position sources are not in a proved chronological order")]
    UnorderedSources,
    /// A slot mixes order spaces or has no comparable within-slot proof.
    #[error("the position sources have ambiguous within-slot order")]
    AmbiguousTransactionOrder,
    /// The same transaction was applied twice.
    #[error("the position transaction {signature} was already applied")]
    DuplicateTransaction {
        /// The duplicate signature.
        signature: Signature,
    },
    /// Failed execution was supplied with economic activity.
    #[error("the failed position transaction has activity")]
    FailedTransactionActivity,
    /// A position is created while its previous life is still open.
    #[error("the position {position} is created while already open")]
    DuplicateCreation {
        /// The position account.
        position: Address,
    },
    /// The existing ID contract cannot distinguish two creations of this address in one TX.
    #[error("the position identity {position} collides within its creating transaction")]
    PositionIdCollision {
        /// The colliding life identity.
        position: PositionId,
    },
    /// A closure contradicts the owner established by creation.
    #[error("the position {position} closes with a contradictory owner")]
    OwnerMismatch {
        /// The position account.
        position: Address,
    },
    /// A movement contradicts the pool established by creation.
    #[error("the position {position} moves in a contradictory pool")]
    PoolMismatch {
        /// The position account.
        position: Address,
    },
    /// Address-only booking cannot distinguish owners changing within the same transaction.
    #[error("the position {position} has ambiguous ownership within one transaction")]
    AmbiguousOwnershipWithinTransaction {
        /// The position account.
        position: Address,
    },
    /// Separate activity vectors cannot prove the order of conflicting rows at the same place.
    #[error("the position {position} has ambiguous activity at {at:?}")]
    AmbiguousActivityOrder {
        /// The position account.
        position: Address,
        /// The conflicting instruction position.
        at: InstructionPosition,
    },
    /// A set of owned addresses must not be used for booking while ownership is unresolved.
    #[error("the transaction's position ownership is unresolved")]
    UnresolvedOwnership,
    /// The replay's known owner has no corresponding created lifetime.
    #[error("the known position life {position} is missing")]
    MissingKnownLifetime {
        /// The missing life identity.
        position: PositionId,
    },
    /// A known closed account moves without being created again.
    #[error("the position {position} moves outside an open lifetime")]
    MovementOutsideLifetime {
        /// The position account.
        position: Address,
    },
    /// A known life is closed again without a new creation.
    #[error("the position {position} closes an already closed lifetime")]
    DuplicateClosure {
        /// The position account.
        position: Address,
    },
}
