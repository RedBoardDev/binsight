//! Fee and reward claims, counted once per claim identity.
//!
//! The program reports one claim several ways: `claim_fee2` emits a `ClaimFee` (no bin) beside
//! its `ClaimFee2`, an event can be emitted twice, and a rebalance that harvests reports the
//! harvest in its `Rebalancing` event. All of them come from the one instruction that paid the
//! claim. A claim is identified by that instruction (its scope), its pool, its position and its
//! amounts (and its reward index for a reward), and is counted once, at the event of the second
//! form when there is one. Each paying instruction makes its own transfer, so two instructions
//! that pay equal amounts (`claim_fee2` over two bin ranges of a position) are two claims. When
//! the emitting instruction cannot be told (a transaction without stack heights), the scope is
//! the whole transaction.
//!
//! This module applies rules 4 to 6 of [`super`]; the rebalance side of rule 3 is in
//! [`super::rebalance`], which asks this book what the claim events report.

use binsight_core::units::RawTokenAmount;
use binsight_solana::Address;
use binsight_solana::transaction::{InstructionPosition, TransactionView};

use super::emitter::{emitter, scope_of};
use super::provenance::{ActivityDiagnostic, ClaimKind, EventSource};
use super::{EventForm, MovementKind, PositionMovement, RewardClaim, TxActivity};
use crate::event::{DlmmEvent, FeeClaimed, LocatedEvent, RewardClaimed};
use crate::instruction::{
    CLAIM_REWARD, CLAIM_REWARD_MINT_ACCOUNT, CLAIM_REWARD2, CLAIM_REWARD2_MINT_ACCOUNT,
    instruction_name,
};

/// The position of the position account among the accounts of both `claim_reward` forms.
const CLAIM_REWARD_POSITION_ACCOUNT: usize = 1;

/// What makes two fee claims the same claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct FeeIdentity {
    pub(super) scope: Option<InstructionPosition>,
    pub(super) pool: Address,
    pub(super) position: Address,
    pub(super) x: RawTokenAmount,
    pub(super) y: RawTokenAmount,
}

impl FeeIdentity {
    fn of(scope: Option<InstructionPosition>, claim: &FeeClaimed) -> Self {
        Self {
            scope,
            pool: claim.lb_pair,
            position: claim.position,
            x: claim.fee_x,
            y: claim.fee_y,
        }
    }
}

/// What makes two reward claims the same claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RewardIdentity {
    pub(super) scope: Option<InstructionPosition>,
    pub(super) pool: Address,
    pub(super) position: Address,
    pub(super) reward_index: u64,
    pub(super) amount: RawTokenAmount,
}

impl RewardIdentity {
    fn of(scope: Option<InstructionPosition>, claim: &RewardClaimed) -> Self {
        Self {
            scope,
            pool: claim.lb_pair,
            position: claim.position,
            reward_index: claim.reward_index,
            amount: claim.total_reward,
        }
    }
}

/// The claim events of one transaction, and the claims already counted.
pub(super) struct ClaimBook<'a> {
    tx: &'a TransactionView,
    events: &'a [LocatedEvent],
    reported_fees: Vec<(FeeIdentity, EventForm, Option<EventSource>)>,
    reported_rewards: Vec<(RewardIdentity, EventForm, Option<EventSource>)>,
    counted_fees: Vec<(FeeIdentity, Option<EventSource>)>,
    counted_rewards: Vec<(RewardIdentity, Option<EventSource>)>,
    current: Option<EventSource>,
    diagnostics: Vec<ActivityDiagnostic>,
}

impl<'a> ClaimBook<'a> {
    /// A book of the claim events among the `events` of `tx`, with nothing counted yet.
    pub(super) fn new(
        tx: &'a TransactionView,
        events: &'a [LocatedEvent],
        sources: &[EventSource],
    ) -> Self {
        let mut book = Self {
            tx,
            events,
            reported_fees: Vec::new(),
            reported_rewards: Vec::new(),
            counted_fees: Vec::new(),
            counted_rewards: Vec::new(),
            current: None,
            diagnostics: Vec::new(),
        };
        for (index, located) in events.iter().enumerate() {
            book.note_reported(located, sources.get(index).copied());
        }
        book
    }

    fn note_reported(&mut self, located: &LocatedEvent, source: Option<EventSource>) {
        let scope = || scope_of(self.tx, located.at);
        match &located.event {
            DlmmEvent::ClaimFee(claim) => {
                self.reported_fees.push((
                    FeeIdentity::of(scope(), claim),
                    EventForm::First,
                    source,
                ));
            }
            DlmmEvent::ClaimFee2 { claim, .. } => self.reported_fees.push((
                FeeIdentity::of(scope(), claim),
                EventForm::Second,
                source,
            )),
            DlmmEvent::ClaimReward(claim) => self.reported_rewards.push((
                RewardIdentity::of(scope(), claim),
                EventForm::First,
                source,
            )),
            DlmmEvent::ClaimReward2 { claim, .. } => self.reported_rewards.push((
                RewardIdentity::of(scope(), claim),
                EventForm::Second,
                source,
            )),
            _ => {}
        }
    }

    /// The instruction that emitted the event at `at`, which scopes the claims it reports.
    pub(super) fn scope(&self, at: InstructionPosition) -> Option<InstructionPosition> {
        scope_of(self.tx, at)
    }

    /// Counts a `ClaimFee2` at `at`, unless its claim is counted already.
    pub(super) fn record_second_form_fee(
        &mut self,
        at: InstructionPosition,
        claim: &FeeClaimed,
        active_bin_id: i32,
        activity: &mut TxActivity,
    ) {
        let identity = FeeIdentity::of(self.scope(at), claim);
        let movement = fee_movement(at, claim, Some(active_bin_id));
        self.count_fee(identity, movement, activity);
    }

    /// Counts a `ClaimFee` at `at`, unless a `ClaimFee2` reports the same claim or its claim is
    /// counted already; it borrows the bin of the first event of its pool (rule 5).
    pub(super) fn record_first_form_fee(
        &mut self,
        at: InstructionPosition,
        claim: &FeeClaimed,
        activity: &mut TxActivity,
    ) {
        let identity = FeeIdentity::of(self.scope(at), claim);
        if self.has_second_form_fee(identity) {
            return;
        }
        let movement = fee_movement(at, claim, self.first_bin_of_pool(claim.lb_pair));
        self.count_fee(identity, movement, activity);
    }

    /// Counts a `ClaimReward2` at `at`, unless its claim is counted already.
    pub(super) fn record_second_form_reward(
        &mut self,
        at: InstructionPosition,
        claim: &RewardClaimed,
        activity: &mut TxActivity,
    ) {
        let identity = RewardIdentity::of(self.scope(at), claim);
        self.count_reward(at, identity, claim, activity);
    }

    /// Counts a `ClaimReward` at `at`, unless a `ClaimReward2` reports the same claim or its
    /// claim is counted already.
    pub(super) fn record_first_form_reward(
        &mut self,
        at: InstructionPosition,
        claim: &RewardClaimed,
        activity: &mut TxActivity,
    ) {
        let identity = RewardIdentity::of(self.scope(at), claim);
        if self.has_second_form_reward(identity) {
            return;
        }
        self.count_reward(at, identity, claim, activity);
    }

    /// Whether a report caused this fee harvest to be suppressed.
    pub(super) fn has_fee_claim_event(&mut self, wanted: FeeIdentity) -> bool {
        self.fee_report(wanted, None)
    }

    /// Whether a report caused this reward harvest to be suppressed.
    pub(super) fn has_reward_claim_event(&mut self, wanted: RewardIdentity) -> bool {
        self.reward_report(wanted, None)
    }

    fn has_second_form_fee(&mut self, wanted: FeeIdentity) -> bool {
        self.fee_report(wanted, Some(EventForm::Second))
    }

    fn has_second_form_reward(&mut self, wanted: RewardIdentity) -> bool {
        self.reward_report(wanted, Some(EventForm::Second))
    }

    fn fee_report(&mut self, wanted: FeeIdentity, form: Option<EventForm>) -> bool {
        let report = self
            .reported_fees
            .iter()
            .find(|&&(identity, reported, _)| {
                identity == wanted && form.is_none_or(|form| reported == form)
            })
            .map(|&(_, _, source)| source);
        if let Some(representative) = report {
            if wanted.scope.is_none() && (wanted.x.0 > 0 || wanted.y.0 > 0) {
                self.note_suppression(wanted.position, ClaimKind::Fee, representative);
            }
            true
        } else {
            false
        }
    }

    fn reward_report(&mut self, wanted: RewardIdentity, form: Option<EventForm>) -> bool {
        let report = self
            .reported_rewards
            .iter()
            .find(|&&(identity, reported, _)| {
                identity == wanted && form.is_none_or(|form| reported == form)
            })
            .map(|&(_, _, source)| source);
        if let Some(representative) = report {
            if wanted.scope.is_none() && wanted.amount.0 > 0 {
                self.note_suppression(wanted.position, ClaimKind::Reward, representative);
            }
            true
        } else {
            false
        }
    }

    pub(super) fn begin_event(&mut self, source: Option<EventSource>) {
        self.current = source;
    }

    pub(super) fn into_diagnostics(self) -> Vec<ActivityDiagnostic> {
        self.diagnostics
    }

    fn note_suppression(
        &mut self,
        position: Address,
        kind: ClaimKind,
        representative: Option<EventSource>,
    ) {
        if let (Some(suppressed), Some(representative)) = (self.current, representative) {
            self.diagnostics.push(ActivityDiagnostic::new(
                position,
                kind,
                (suppressed, representative),
            ));
        }
    }

    fn count_fee(
        &mut self,
        identity: FeeIdentity,
        movement: PositionMovement,
        activity: &mut TxActivity,
    ) {
        if let Some(representative) = self
            .counted_fees
            .iter()
            .find(|&&(known, _)| known == identity)
            .map(|&(_, source)| source)
        {
            if identity.scope.is_none() && (identity.x.0 > 0 || identity.y.0 > 0) {
                self.note_suppression(identity.position, ClaimKind::Fee, representative);
            }
            return;
        }
        self.counted_fees.push((identity, self.current));
        activity.movements.push(movement);
    }

    fn count_reward(
        &mut self,
        at: InstructionPosition,
        identity: RewardIdentity,
        claim: &RewardClaimed,
        activity: &mut TxActivity,
    ) {
        if let Some(representative) = self
            .counted_rewards
            .iter()
            .find(|&&(known, _)| known == identity)
            .map(|&(_, source)| source)
        {
            if identity.scope.is_none() && identity.amount.0 > 0 {
                self.note_suppression(identity.position, ClaimKind::Reward, representative);
            }
            return;
        }
        self.counted_rewards.push((identity, self.current));
        activity.reward_claims.push(RewardClaim {
            at,
            position: claim.position,
            pool: claim.lb_pair,
            reward_index: claim.reward_index,
            mint: self.reward_mint(at, claim.position),
            amount: claim.total_reward,
        });
    }

    /// The active bin of the first event of `pool` that carries one (rule 5).
    fn first_bin_of_pool(&self, pool: Address) -> Option<i32> {
        self.events
            .iter()
            .filter_map(|located| pool_and_bin(&located.event))
            .find(|&(event_pool, _)| event_pool == pool)
            .map(|(_, bin)| bin)
    }

    /// The reward mint named by the instruction that emitted the claim at `at`, when that
    /// instruction is a reward claim of `position`.
    fn reward_mint(&self, at: InstructionPosition, position: Address) -> Option<Address> {
        let instruction = emitter(self.tx, at)?;
        let mint_account = match instruction_name(instruction)? {
            CLAIM_REWARD => CLAIM_REWARD_MINT_ACCOUNT,
            CLAIM_REWARD2 => CLAIM_REWARD2_MINT_ACCOUNT,
            _ => return None,
        };
        let claims_this_position =
            instruction.accounts.get(CLAIM_REWARD_POSITION_ACCOUNT) == Some(&position);
        if !claims_this_position {
            return None;
        }
        instruction.accounts.get(mint_account).copied()
    }
}

fn fee_movement(
    at: InstructionPosition,
    claim: &FeeClaimed,
    price_bin: Option<i32>,
) -> PositionMovement {
    PositionMovement {
        at,
        position: claim.position,
        pool: claim.lb_pair,
        kind: MovementKind::FeeClaim,
        x: claim.fee_x,
        y: claim.fee_y,
        price_bin,
    }
}

/// The pool and active bin an event reports, if it reports both.
fn pool_and_bin(event: &DlmmEvent) -> Option<(Address, i32)> {
    match event {
        DlmmEvent::AddLiquidity(change) | DlmmEvent::RemoveLiquidity(change) => {
            Some((change.lb_pair, change.active_bin_id))
        }
        DlmmEvent::Rebalancing(rebalance) => Some((rebalance.lb_pair, rebalance.active_bin_id)),
        DlmmEvent::ClaimFee2 {
            claim,
            active_bin_id,
        } => Some((claim.lb_pair, *active_bin_id)),
        DlmmEvent::ClaimReward2 {
            claim,
            active_bin_id,
        } => Some((claim.lb_pair, *active_bin_id)),
        DlmmEvent::PlaceLimitOrder(order) => Some((order.lb_pair, order.active_id)),
        DlmmEvent::CancelLimitOrder(order) => Some((order.lb_pair, order.active_id)),
        _ => None,
    }
}
