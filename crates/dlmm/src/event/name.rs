//! The names of the events the DLMM program emits, and the discriminator that marks each one.
//!
//! The program writes an 8-byte discriminator before the fields of each event: the first 8 bytes
//! of `sha256("event:<Name>")`, where `<Name>` is the event's name in the program's IDL (`lb_clmm`
//! 0.12.0). This module only maps discriminators to names; reading the fields is the job of
//! [`super::layout`].

use std::fmt;

/// An event the DLMM program is known to emit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EventName {
    /// Liquidity added to a position.
    AddLiquidity,
    /// A limit order cancelled, its unfilled tokens returned.
    CancelLimitOrder,
    /// The swap fees of a position paid to its owner (first form, without the active bin).
    ClaimFee,
    /// The swap fees of a position paid to its owner, with the active bin.
    ClaimFee2,
    /// A farming reward of a position paid to its owner (first form, without the active bin).
    ClaimReward,
    /// A farming reward of a position paid to its owner, with the active bin.
    ClaimReward2,
    /// An empty limit order account closed.
    CloseLimitOrder,
    /// The fee charged on liquidity added to the active bin.
    CompositionFee,
    /// A position made shorter by some bins.
    DecreasePositionLength,
    /// The dynamic fee parameters of a pool changed.
    DynamicFeeParameterUpdate,
    /// The base fee parameters of a pool changed.
    FeeParameterUpdate,
    /// A farming reward funded.
    FundReward,
    /// The active bin of an empty pool moved.
    GoToABin,
    /// The price oracle of a pool made longer.
    IncreaseObservation,
    /// A position made longer by some bins.
    IncreasePositionLength,
    /// A farming reward created on a pool.
    InitializeReward,
    /// A pool created.
    LbPairCreate,
    /// A limit order placed.
    PlaceLimitOrder,
    /// A position closed.
    PositionClose,
    /// A position created.
    PositionCreate,
    /// Liquidity moved inside a position, possibly harvesting its fees and rewards.
    Rebalancing,
    /// Liquidity removed from a position.
    RemoveLiquidity,
    /// The operations anyone may run on a position changed.
    SetPositionPermissionlessOperationBits,
    /// A swap against a pool (first form).
    Swap,
    /// A swap against a pool, with its limit-order fill (second form).
    Swap2,
    /// The lock of a position moved.
    UpdatePositionLockReleasePoint,
    /// The operator of a position changed.
    UpdatePositionOperator,
    /// The duration of a farming reward changed.
    UpdateRewardDuration,
    /// The funder of a farming reward changed.
    UpdateRewardFunder,
    /// Farming rewards nobody was eligible for withdrawn.
    WithdrawIneligibleReward,
}

impl EventName {
    /// Every known event, in the order of the IDL.
    pub const ALL: [Self; 30] = [
        Self::AddLiquidity,
        Self::CancelLimitOrder,
        Self::ClaimFee,
        Self::ClaimFee2,
        Self::ClaimReward,
        Self::ClaimReward2,
        Self::CloseLimitOrder,
        Self::CompositionFee,
        Self::DecreasePositionLength,
        Self::DynamicFeeParameterUpdate,
        Self::FeeParameterUpdate,
        Self::FundReward,
        Self::GoToABin,
        Self::IncreaseObservation,
        Self::IncreasePositionLength,
        Self::InitializeReward,
        Self::LbPairCreate,
        Self::PlaceLimitOrder,
        Self::PositionClose,
        Self::PositionCreate,
        Self::Rebalancing,
        Self::RemoveLiquidity,
        Self::SetPositionPermissionlessOperationBits,
        Self::Swap,
        Self::Swap2,
        Self::UpdatePositionLockReleasePoint,
        Self::UpdatePositionOperator,
        Self::UpdateRewardDuration,
        Self::UpdateRewardFunder,
        Self::WithdrawIneligibleReward,
    ];

    /// The event marked by `discriminator`, if the program is known to emit it.
    pub fn from_discriminator(discriminator: [u8; 8]) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|name| name.discriminator() == discriminator)
    }

    /// The 8 bytes that mark this event in the program's data.
    pub fn discriminator(self) -> [u8; 8] {
        self.identity().2.to_be_bytes()
    }

    /// Its name in the program's IDL, such as `Swap2Evt`.
    pub fn idl_name(self) -> &'static str {
        self.identity().0
    }

    /// Its kind in snake case, such as `add_liquidity`: the name binsight stores it under.
    pub fn kind(self) -> &'static str {
        self.identity().1
    }

    /// Its name in the IDL, its kind, and its discriminator written as the big-endian number of
    /// its 8 bytes (as explorers show it).
    fn identity(self) -> (&'static str, &'static str, u64) {
        match self {
            Self::AddLiquidity => ("AddLiquidity", "add_liquidity", 0x1f5e_7d5a_e334_3dba),
            Self::CancelLimitOrder => (
                "CancelLimitOrderEvt",
                "cancel_limit_order",
                0x83ea_c285_090e_bdd1,
            ),
            Self::ClaimFee => ("ClaimFee", "claim_fee", 0x4b7a_9a30_8c4a_7ba3),
            Self::ClaimFee2 => ("ClaimFee2", "claim_fee2", 0xe8ab_f261_3a4d_232d),
            Self::ClaimReward => ("ClaimReward", "claim_reward", 0x9474_86cc_16ab_555f),
            Self::ClaimReward2 => ("ClaimReward2", "claim_reward2", 0x1b8f_f421_502b_6e92),
            Self::CloseLimitOrder => (
                "CloseLimitOrderEvt",
                "close_limit_order",
                0x8e87_084c_5c3f_7653,
            ),
            Self::CompositionFee => ("CompositionFee", "composition_fee", 0x8097_7b6a_1166_718e),
            Self::DecreasePositionLength => (
                "DecreasePositionLength",
                "decrease_position_length",
                0x3476_eb55_aca9_0f80,
            ),
            Self::DynamicFeeParameterUpdate => (
                "DynamicFeeParameterUpdate",
                "dynamic_fee_parameter_update",
                0x5858_b287_c292_5bf3,
            ),
            Self::FeeParameterUpdate => (
                "FeeParameterUpdate",
                "fee_parameter_update",
                0x304c_f175_90d7_f22c,
            ),
            Self::FundReward => ("FundReward", "fund_reward", 0xf6e4_3a82_91aa_4fcc),
            Self::GoToABin => ("GoToABin", "go_to_a_bin", 0x3b8a_4c44_8a83_b043),
            Self::IncreaseObservation => (
                "IncreaseObservation",
                "increase_observation",
                0x63f9_1179_a69c_cfd7,
            ),
            Self::IncreasePositionLength => (
                "IncreasePositionLength",
                "increase_position_length",
                0x9def_2acc_1e38_df2e,
            ),
            Self::InitializeReward => (
                "InitializeReward",
                "initialize_reward",
                0xd399_583e_953c_b146,
            ),
            Self::LbPairCreate => ("LbPairCreate", "lb_pair_create", 0xb94a_fc7d_1bd7_bc6f),
            Self::PlaceLimitOrder => (
                "PlaceLimitOrderEvt",
                "place_limit_order",
                0x2b4f_1ba9_f41c_e13f,
            ),
            Self::PositionClose => ("PositionClose", "position_close", 0xffc4_106b_1cca_3580),
            Self::PositionCreate => ("PositionCreate", "position_create", 0x908e_fc54_9d35_2579),
            Self::Rebalancing => ("Rebalancing", "rebalancing", 0x006d_75b3_3d5b_c7c8),
            Self::RemoveLiquidity => ("RemoveLiquidity", "remove_liquidity", 0x74f4_61e8_671f_983a),
            Self::SetPositionPermissionlessOperationBits => (
                "SetPositionPermissionlessOperationBitsEvt",
                "set_position_permissionless_operation_bits",
                0xc3e5_93f5_1d7d_30a8,
            ),
            Self::Swap => ("Swap", "swap", 0x516c_e3be_cdd0_0ac4),
            Self::Swap2 => ("Swap2Evt", "swap2", 0x2e74_52d7_941b_544d),
            Self::UpdatePositionLockReleasePoint => (
                "UpdatePositionLockReleasePoint",
                "update_position_lock_release_point",
                0x85d6_42e0_400c_07bf,
            ),
            Self::UpdatePositionOperator => (
                "UpdatePositionOperator",
                "update_position_operator",
                0x2773_30cc_f62f_4239,
            ),
            Self::UpdateRewardDuration => (
                "UpdateRewardDuration",
                "update_reward_duration",
                0xdff5_e099_311d_a3ac,
            ),
            Self::UpdateRewardFunder => (
                "UpdateRewardFunder",
                "update_reward_funder",
                0xe0b2_ae4a_fca5_55b4,
            ),
            Self::WithdrawIneligibleReward => (
                "WithdrawIneligibleReward",
                "withdraw_ineligible_reward",
                0xe7bd_4195_66d7_9af4,
            ),
        }
    }
}

impl fmt::Display for EventName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.idl_name())
    }
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn every_event_discriminator_is_sha256_of_event_and_its_name() {
        for name in EventName::ALL {
            let hash = Sha256::digest(format!("event:{}", name.idl_name()));
            assert_eq!(name.discriminator(), hash[..8], "{name}");
        }
    }

    #[test]
    fn finds_every_event_by_its_discriminator() {
        for name in EventName::ALL {
            assert_eq!(
                EventName::from_discriminator(name.discriminator()),
                Some(name)
            );
        }
        assert_eq!(EventName::from_discriminator([0; 8]), None);
    }

    #[test]
    fn names_each_event_once() {
        let mut kinds: Vec<_> = EventName::ALL.map(EventName::kind).to_vec();
        kinds.sort_unstable();
        kinds.dedup();
        assert_eq!(kinds.len(), 30);
    }
}
