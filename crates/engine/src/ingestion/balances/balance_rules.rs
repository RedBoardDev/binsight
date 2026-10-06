//! When a token account disagrees with the registry, and when the comparison runs, as pure
//! rules.
//!
//! The registry knows, for each token account a wallet owns, the amount its newest registry
//! transaction left. The chain says what the account holds now. They disagree when the account
//! holds another amount, is gone, or is no longer a token account; a reading older than the
//! registry's newest transaction compares nothing. A disagreement is only acted on if it holds
//! two minutes later and the registry did not move meanwhile: a transaction in flight would
//! explain it. The same disagreement, unexplained by a listing, is not listed again. This module
//! decides; it does no I/O.

use binsight_core::units::RawTokenAmount;
use binsight_solana::{Address, Signature};
use binsight_store::TokenAccountBalance;
use jiff::SignedDuration;

/// How long after startup the first comparison runs: the stream, the top-ups and the decoder
/// have caught up by then.
pub(super) const FIRST_CHECK_DELAY: SignedDuration = SignedDuration::from_mins(10);

/// How often the comparison runs.
pub(super) const CHECK_INTERVAL: SignedDuration = SignedDuration::from_hours(24);

/// How long a disagreement must hold before it is acted on.
pub(super) const RECHECK_DELAY: SignedDuration = SignedDuration::from_mins(2);

/// What the chain holds in a token account, read at a slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct OnChain {
    /// The slot the node read it at.
    pub(super) slot: u64,
    /// Its amount; `None` when there is no token account at that address any more.
    pub(super) amount: Option<RawTokenAmount>,
}

/// A disagreement, as it was seen: the registry's newest transaction for the account and what
/// the chain held. The same key seen again is the same disagreement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) struct DisagreementKey {
    /// The token account.
    pub(super) token_account: Address,
    /// The registry's newest transaction that touched it.
    pub(super) last_signature: Signature,
    /// What the chain held.
    pub(super) on_chain: Option<RawTokenAmount>,
}

/// Whether `known`, what the registry last saw of an account, disagrees with `on_chain`.
pub(super) fn disagrees(known: &TokenAccountBalance, on_chain: &OnChain) -> bool {
    known.slot <= on_chain.slot && on_chain.amount != Some(known.amount)
}

/// The key of the disagreement between `known` and `on_chain`.
pub(super) fn key_of(known: &TokenAccountBalance, on_chain: &OnChain) -> DisagreementKey {
    DisagreementKey {
        token_account: known.token_account,
        last_signature: known.signature,
        on_chain: on_chain.amount,
    }
}

/// Whether the registry still sees the account as `before` did: same newest transaction, same
/// amount. Otherwise it moved, and the disagreement may be gone.
pub(super) fn is_unchanged(before: &TokenAccountBalance, now: &TokenAccountBalance) -> bool {
    before.signature == now.signature && before.amount == now.amount
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known(slot: u64, amount: u128) -> TokenAccountBalance {
        TokenAccountBalance {
            wallet: Address::from_bytes([1; 32]),
            token_account: Address::from_bytes([2; 32]),
            mint: Address::from_bytes([3; 32]),
            signature: Signature::from_bytes([4; 64]),
            slot,
            transaction_index: Some(0),
            amount: RawTokenAmount(amount),
            is_owned: true,
        }
    }

    fn chain(slot: u64, amount: Option<u128>) -> OnChain {
        OnChain {
            slot,
            amount: amount.map(RawTokenAmount),
        }
    }

    #[test]
    fn agrees_when_the_account_holds_what_the_registry_last_saw() {
        assert!(!disagrees(&known(100, 50), &chain(200, Some(50))));
    }

    #[test]
    fn disagrees_when_the_account_holds_more_less_or_is_gone() {
        assert!(disagrees(&known(100, 50), &chain(200, Some(80))));
        assert!(disagrees(&known(100, 50), &chain(200, Some(10))));
        assert!(disagrees(&known(100, 50), &chain(200, None)));
    }

    #[test]
    fn compares_nothing_read_before_the_registry_newest_transaction() {
        assert!(!disagrees(&known(300, 50), &chain(200, Some(80))));
    }

    #[test]
    fn sees_the_registry_move_when_a_newer_transaction_touched_the_account() {
        let before = known(100, 50);
        let moved = TokenAccountBalance {
            signature: Signature::from_bytes([5; 64]),
            ..known(150, 80)
        };

        assert!(is_unchanged(&before, &before));
        assert!(!is_unchanged(&before, &moved));
    }
}
