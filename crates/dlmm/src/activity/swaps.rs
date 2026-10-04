//! Swaps against a pool, counted once each.
//!
//! A `swap*` instruction of the program in its 0.12 form emits its swap twice: as `Swap` and as
//! `Swap2Evt`, with the same amounts. One instruction swaps once in one pool, so the swaps of a
//! transaction are counted once per emitting instruction and pool, keeping the second form. When
//! the emitting instruction cannot be told (a transaction without stack heights), two events
//! are the same swap when they report the same pool, direction and amounts.

use binsight_core::units::RawTokenAmount;
use binsight_solana::Address;
use binsight_solana::transaction::{InstructionPosition, TransactionView};

use super::emitter::scope_of;
use super::{EventForm, PoolSwap};
use crate::event::{DlmmEvent, LocatedEvent, Swapped};

/// What makes two swap events the same swap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SwapIdentity {
    /// One swap per emitting instruction and pool.
    Call {
        scope: InstructionPosition,
        pool: Address,
    },
    /// Without the emitting instruction: the pool, the direction and the amounts.
    Amounts {
        pool: Address,
        swap_for_y: bool,
        amount_in: RawTokenAmount,
        amount_out: RawTokenAmount,
    },
}

impl SwapIdentity {
    fn of(scope: Option<InstructionPosition>, swap: &Swapped) -> Self {
        match scope {
            Some(scope) => Self::Call {
                scope,
                pool: swap.lb_pair,
            },
            None => Self::Amounts {
                pool: swap.lb_pair,
                swap_for_y: swap.swap_for_y,
                amount_in: swap.amount_in,
                amount_out: swap.amount_out,
            },
        }
    }
}

/// A swap event, its identity and its form.
struct ReportedSwap {
    at: InstructionPosition,
    identity: SwapIdentity,
    form: EventForm,
    swap: Swapped,
}

/// The swaps of `events`, once each, in execution order.
pub(super) fn pool_swaps(tx: &TransactionView, events: &[LocatedEvent]) -> Vec<PoolSwap> {
    let reported: Vec<ReportedSwap> = events
        .iter()
        .filter_map(|located| {
            let (form, swap) = match located.event {
                DlmmEvent::Swap(swap) => (EventForm::First, swap),
                DlmmEvent::Swap2(swap) => (EventForm::Second, swap),
                _ => return None,
            };
            let identity = SwapIdentity::of(scope_of(tx, located.at), &swap);
            Some(ReportedSwap {
                at: located.at,
                identity,
                form,
                swap,
            })
        })
        .collect();
    let mut counted: Vec<SwapIdentity> = Vec::new();
    let mut swaps = Vec::new();
    for candidate in &reported {
        let has_second_form = reported
            .iter()
            .any(|other| other.identity == candidate.identity && other.form == EventForm::Second);
        let is_twin_of_second_form = candidate.form == EventForm::First && has_second_form;
        if is_twin_of_second_form || counted.contains(&candidate.identity) {
            continue;
        }
        counted.push(candidate.identity);
        swaps.push(PoolSwap {
            at: candidate.at,
            pool: candidate.swap.lb_pair,
            swap: candidate.swap,
        });
    }
    swaps
}
