//! The instructions of the DLMM program: name, discriminator and kind of each one.
//!
//! The discriminator of an instruction is the first 8 bytes of `sha256("global:<name>")`, where
//! `<name>` is its name in the program's IDL (`lb_clmm` 0.12.0). The table is data only; the
//! lookups are in [`super`].

use super::InstructionKind;

/// `initialize_position`, whose position account is at [`OPEN_POSITION_ACCOUNT`].
pub(crate) const INITIALIZE_POSITION: &str = "initialize_position";

/// `initialize_position2`, whose position account is at [`OPEN_POSITION_ACCOUNT`].
pub(crate) const INITIALIZE_POSITION2: &str = "initialize_position2";

/// `initialize_position_by_operator`, whose position account is at
/// [`OPEN_DERIVED_POSITION_ACCOUNT`] (after its `base`).
pub(crate) const INITIALIZE_POSITION_BY_OPERATOR: &str = "initialize_position_by_operator";

/// `initialize_position_pda`, whose position account is at [`OPEN_DERIVED_POSITION_ACCOUNT`]
/// (after its `base`).
pub(crate) const INITIALIZE_POSITION_PDA: &str = "initialize_position_pda";

/// The position of the position account among the accounts of `initialize_position` and
/// `initialize_position2` (after the payer).
pub(crate) const OPEN_POSITION_ACCOUNT: usize = 1;

/// The position of the position account among the accounts of the two forms that derive it from
/// a `base` key (after the payer and the base).
pub(crate) const OPEN_DERIVED_POSITION_ACCOUNT: usize = 2;

/// `claim_reward`, whose accounts name the reward mint at [`CLAIM_REWARD_MINT_ACCOUNT`].
pub(crate) const CLAIM_REWARD: &str = "claim_reward";

/// `claim_reward2`, whose accounts name the reward mint at [`CLAIM_REWARD2_MINT_ACCOUNT`].
pub(crate) const CLAIM_REWARD2: &str = "claim_reward2";

/// The position of the reward mint among the accounts of `claim_reward`.
pub(crate) const CLAIM_REWARD_MINT_ACCOUNT: usize = 6;

/// The position of the reward mint among the accounts of `claim_reward2`.
pub(crate) const CLAIM_REWARD2_MINT_ACCOUNT: usize = 4;

/// The positions of the pool's two reserves (X, then Y) among the accounts of
/// `rebalance_liquidity`. A harvested reward is paid from the reward vault, never from them.
pub(crate) const REBALANCE_RESERVE_ACCOUNTS: [usize; 2] = [5, 6];

/// Every instruction of the program, grouped by kind: its IDL name and its discriminator, written
/// as the big-endian number of its 8 bytes (as explorers show it).
pub(super) const INSTRUCTIONS: [(InstructionKind, &[(&str, u64)]); 12] = [
    (
        InstructionKind::OpenPosition,
        &[
            (INITIALIZE_POSITION, 0xdbc0_ea47_bebf_6650),
            (INITIALIZE_POSITION2, 0x8f13_f291_d50f_6873),
            (INITIALIZE_POSITION_BY_OPERATOR, 0xfbbd_bef4_75fe_2394),
            (INITIALIZE_POSITION_PDA, 0x2e52_7d92_558d_e499),
        ],
    ),
    (
        InstructionKind::AddLiquidity,
        &[
            ("add_liquidity", 0xb59d_5943_8fb6_3448),
            ("add_liquidity2", 0xe4a2_4e1c_46db_7473),
            ("add_liquidity_by_strategy", 0x0703_967f_9428_3dc8),
            ("add_liquidity_by_strategy2", 0x03dd_95da_6f8d_76d5),
            ("add_liquidity_by_strategy_one_side", 0x2905_eeaf_64e1_06cd),
            ("add_liquidity_by_weight", 0x1c8c_ee63_e7a2_1595),
            ("add_liquidity_by_weight2", 0xd13b_3f5b_6fc8_99e4),
            ("add_liquidity_one_side", 0x5e9b_6797_465f_dca5),
            ("add_liquidity_one_side_precise", 0xa1c2_6754_ab47_fa9a),
            ("add_liquidity_one_side_precise2", 0x2133_a3c9_7562_7de7),
        ],
    ),
    (
        InstructionKind::RemoveLiquidity,
        &[
            ("remove_all_liquidity", 0x0a33_3d23_7069_1855),
            ("remove_liquidity", 0x5055_d148_18ce_b16c),
            ("remove_liquidity2", 0xe6d7_527f_f165_e392),
            ("remove_liquidity_by_range", 0x1a52_6698_f04a_691a),
            ("remove_liquidity_by_range2", 0xcc02_c391_3591_91cd),
        ],
    ),
    (
        InstructionKind::ClaimFee,
        &[
            ("claim_fee", 0xa920_4f89_88e8_4689),
            ("claim_fee2", 0x70bf_65ab_1c90_7fbb),
        ],
    ),
    (
        InstructionKind::ClaimReward,
        &[
            ("claim_reward", 0x955f_b5f2_5e5a_9ea2),
            ("claim_reward2", 0xbe03_7f77_b257_9db7),
        ],
    ),
    (
        InstructionKind::ClosePosition,
        &[
            ("close_position", 0x7b86_5100_3144_6262),
            ("close_position2", 0xae5a_2373_ba28_93e2),
            ("close_position_if_empty", 0x3b7c_d476_5b98_6e9d),
        ],
    ),
    (
        InstructionKind::Rebalance,
        &[("rebalance_liquidity", 0x5c04_b0c1_77b9_5309)],
    ),
    (
        InstructionKind::PositionLength,
        &[
            ("decrease_position_length", 0xc2db_8820_1960_6925),
            ("increase_position_length", 0x5053_75d3_420d_2195),
            ("increase_position_length2", 0xffd2_cc47_7389_e171),
        ],
    ),
    (
        InstructionKind::LimitOrder,
        &[
            ("cancel_limit_order", 0x849c_841f_4328_e861),
            ("close_limit_order_if_empty", 0x397c_249b_7ef9_5dab),
            ("place_limit_order", 0x6cb0_21ba_92e5_01c5),
        ],
    ),
    (
        InstructionKind::Swap,
        &[
            ("swap", 0xf8c6_9e91_e175_87c8),
            ("swap2", 0x414b_3f4c_eb5b_5b88),
            ("swap_exact_out", 0xfa49_6521_26cf_4bb8),
            ("swap_exact_out2", 0x2bd7_f784_893c_f351),
            ("swap_with_price_impact", 0x38ad_e6d0_ade4_9ccd),
            ("swap_with_price_impact2", 0x4a62_c0d6_b133_4b33),
        ],
    ),
    (
        InstructionKind::BinArray,
        &[
            ("close_bin_array", 0x44ae_5850_b5cc_13e0),
            ("initialize_bin_array", 0x2356_13b9_4ed4_4bd3),
            (
                "initialize_bin_array_bitmap_extension",
                0x2f9d_e2b4_0cf0_2147,
            ),
        ],
    ),
    (
        InstructionKind::Admin,
        &[
            ("close_claim_fee_operator_account", 0xb8d5_581f_b365_8224),
            ("close_operator_account", 0xab09_d54a_7817_031d),
            ("close_preset_parameter", 0x0494_9164_861a_b53d),
            ("close_preset_parameter2", 0x2719_5f6b_7411_731c),
            ("close_token_badge", 0x6c92_566e_b3fe_0a68),
            ("create_operator_account", 0xdd40_f695_f099_e5a3),
            ("for_idl_type_generation_do_not_call", 0xb469_4550_5f32_496c),
            ("fund_reward", 0xbc32_f9a5_5d97_263f),
            ("go_to_a_bin", 0x9248_aee0_28fd_54ae),
            ("increase_oracle_length", 0xbe3d_7d57_674f_9ead),
            (
                "initialize_customizable_permissionless_lb_pair",
                0x2e27_2987_6fb7_c840,
            ),
            (
                "initialize_customizable_permissionless_lb_pair2",
                0xf349_817e_3313_f16b,
            ),
            ("initialize_lb_pair", 0x2d9a_edd2_dd0f_a65c),
            ("initialize_lb_pair2", 0x493b_2478_ed53_6cc6),
            ("initialize_permission_lb_pair", 0x6c66_d555_fb03_3515),
            ("initialize_preset_parameter", 0x42bc_47d3_626d_0eba),
            ("initialize_reward", 0x5f87_c0c4_f281_e644),
            ("initialize_token_badge", 0xfd4d_cd5f_1be0_59df),
            ("set_activation_point", 0x5bf9_0fa5_1a81_fe7d),
            ("set_pair_status", 0x43f8_e789_9a95_d9ae),
            ("set_pair_status_permissionless", 0x4e3b_98d3_46b7_2ed0),
            ("set_permissionless_operation_bits", 0x543a_cb8b_a351_beba),
            ("set_pre_activation_duration", 0xa53d_c9f4_829f_1664),
            ("set_pre_activation_swap_address", 0x398b_2f7b_d850_df0a),
            ("update_base_fee_parameters", 0x4ba8_dfa1_10c3_032f),
            ("update_dynamic_fee_parameters", 0x5ca1_2ef6_ffbd_1616),
            ("update_fees_and_reward2", 0x208e_b89a_6741_b858),
            ("update_fees_and_rewards", 0x9ae6_fa0d_ecd1_4bdf),
            ("update_position_operator", 0xcab8_678f_b4bf_74d9),
            ("update_reward_duration", 0x8aae_c4a9_d5eb_fe6b),
            ("update_reward_funder", 0xd31c_3020_d7a0_2317),
            ("withdraw_ineligible_reward", 0x94ce_2ac3_f731_6708),
            ("withdraw_protocol_fee", 0x9ec9_9ebd_215d_a267),
            ("zap_protocol_fee", 0xd59b_bb22_38b6_5bf0),
        ],
    ),
];

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    fn every_instruction() -> impl Iterator<Item = (&'static str, u64)> {
        INSTRUCTIONS
            .iter()
            .flat_map(|(_, instructions)| instructions.iter().copied())
    }

    #[test]
    fn every_instruction_discriminator_is_sha256_of_global_and_its_name() {
        for (name, discriminator) in every_instruction() {
            let hash = Sha256::digest(format!("global:{name}"));
            assert_eq!(discriminator.to_be_bytes(), hash[..8], "{name}");
        }
    }

    #[test]
    fn names_each_instruction_once() {
        let mut names: Vec<_> = every_instruction().map(|(name, _)| name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 76);
    }
}
