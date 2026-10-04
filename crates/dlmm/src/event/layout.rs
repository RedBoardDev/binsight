//! Reading the fields of each modelled event from its Borsh bytes, as a tolerant prefix.
//!
//! Each reader reads, in IDL order, the fields up to the last one binsight needs, skipping the
//! ones in between that it does not keep, and ignores whatever follows: a newer program that
//! appends fields to an event changes nothing here. A field that is cut short is an error. This
//! module knows the byte layouts (`lb_clmm` 0.12.0); what the fields mean is in [`super::contents`].

use binsight_core::units::RawTokenAmount;
use binsight_solana::{Address, ByteReader, MalformedBytes};

use super::contents::{
    CompositionFeeCharged, FeeClaimed, LimitOrderCancelled, LimitOrderClosed, LimitOrderPlaced,
    LiquidityChanged, PositionClosed, PositionCreated, PositionLengthChanged, Rebalanced,
    RewardClaimed, Swapped,
};
use super::{DlmmEvent, EventName};

/// The bytes of the four bins (old and new range) a `Rebalancing` event carries before its
/// rewards, which binsight does not keep.
const REBALANCING_RANGE_BYTES: usize = 16;

/// The bytes of the padding of the parameters of a limit order.
const LIMIT_ORDER_PADDING_BYTES: usize = 16;

/// The bytes of a relative bin (two `i32`) in the parameters of a limit order.
const RELATIVE_BIN_BYTES: usize = 8;

/// Reads the fields of the event `name` from the bytes that follow its discriminator.
pub(super) fn read_fields(name: EventName, bytes: &[u8]) -> Result<DlmmEvent, MalformedBytes> {
    let reader = &mut ByteReader::new(bytes);
    let event = match name {
        EventName::PositionCreate => DlmmEvent::PositionCreate(PositionCreated {
            lb_pair: reader.read_address("lb_pair")?,
            position: reader.read_address("position")?,
            owner: reader.read_address("owner")?,
        }),
        EventName::PositionClose => DlmmEvent::PositionClose(PositionClosed {
            position: reader.read_address("position")?,
            owner: reader.read_address("owner")?,
        }),
        EventName::AddLiquidity => DlmmEvent::AddLiquidity(liquidity_changed(reader)?),
        EventName::RemoveLiquidity => DlmmEvent::RemoveLiquidity(liquidity_changed(reader)?),
        EventName::Rebalancing => DlmmEvent::Rebalancing(rebalanced(reader)?),
        EventName::ClaimFee => DlmmEvent::ClaimFee(fee_claimed(reader)?),
        EventName::ClaimFee2 => DlmmEvent::ClaimFee2 {
            claim: fee_claimed(reader)?,
            active_bin_id: reader.read_i32("active_bin_id")?,
        },
        EventName::ClaimReward => DlmmEvent::ClaimReward(reward_claimed(reader)?),
        EventName::ClaimReward2 => DlmmEvent::ClaimReward2 {
            claim: reward_claimed(reader)?,
            active_bin_id: reader.read_i32("active_bin_id")?,
        },
        EventName::Swap => DlmmEvent::Swap(swapped(reader)?),
        EventName::Swap2 => DlmmEvent::Swap2(swapped_second_form(reader)?),
        EventName::PlaceLimitOrder => DlmmEvent::PlaceLimitOrder(limit_order_placed(reader)?),
        EventName::CancelLimitOrder => DlmmEvent::CancelLimitOrder(LimitOrderCancelled {
            lb_pair: reader.read_address("lb_pair")?,
            from: reader.read_address("from")?,
            limit_order: reader.read_address("limit_order")?,
            amount_x: amount(reader, "amounts[0]")?,
            amount_y: amount(reader, "amounts[1]")?,
            active_id: reader.read_i32("active_id")?,
        }),
        EventName::CloseLimitOrder => DlmmEvent::CloseLimitOrder(LimitOrderClosed {
            lb_pair: reader.read_address("lb_pair")?,
            owner: reader.read_address("owner")?,
            limit_order: reader.read_address("limit_order")?,
        }),
        EventName::CompositionFee => DlmmEvent::CompositionFee(CompositionFeeCharged {
            from: reader.read_address("from")?,
            bin_id: reader.read_i16("bin_id")?,
            token_x_fee_amount: amount(reader, "token_x_fee_amount")?,
            token_y_fee_amount: amount(reader, "token_y_fee_amount")?,
        }),
        EventName::IncreasePositionLength => {
            DlmmEvent::IncreasePositionLength(position_length_changed(reader)?)
        }
        EventName::DecreasePositionLength => {
            DlmmEvent::DecreasePositionLength(position_length_changed(reader)?)
        }
        EventName::DynamicFeeParameterUpdate
        | EventName::FeeParameterUpdate
        | EventName::FundReward
        | EventName::GoToABin
        | EventName::IncreaseObservation
        | EventName::InitializeReward
        | EventName::LbPairCreate
        | EventName::SetPositionPermissionlessOperationBits
        | EventName::UpdatePositionLockReleasePoint
        | EventName::UpdatePositionOperator
        | EventName::UpdateRewardDuration
        | EventName::UpdateRewardFunder
        | EventName::WithdrawIneligibleReward => DlmmEvent::Unmodelled(name),
    };
    Ok(event)
}

/// A `u64` token amount.
fn amount(
    reader: &mut ByteReader<'_>,
    what: &'static str,
) -> Result<RawTokenAmount, MalformedBytes> {
    reader
        .read_u64(what)
        .map(|value| RawTokenAmount(u128::from(value)))
}

fn liquidity_changed(reader: &mut ByteReader<'_>) -> Result<LiquidityChanged, MalformedBytes> {
    Ok(LiquidityChanged {
        lb_pair: reader.read_address("lb_pair")?,
        from: reader.read_address("from")?,
        position: reader.read_address("position")?,
        amount_x: amount(reader, "amounts[0]")?,
        amount_y: amount(reader, "amounts[1]")?,
        active_bin_id: reader.read_i32("active_bin_id")?,
    })
}

fn rebalanced(reader: &mut ByteReader<'_>) -> Result<Rebalanced, MalformedBytes> {
    let lb_pair = reader.read_address("lb_pair")?;
    let position = reader.read_address("position")?;
    let owner = reader.read_address("owner")?;
    let active_bin_id = reader.read_i32("active_bin_id")?;
    let x_withdrawn_amount = amount(reader, "x_withdrawn_amount")?;
    let x_added_amount = amount(reader, "x_added_amount")?;
    let y_withdrawn_amount = amount(reader, "y_withdrawn_amount")?;
    let y_added_amount = amount(reader, "y_added_amount")?;
    let x_fee_amount = amount(reader, "x_fee_amount")?;
    let y_fee_amount = amount(reader, "y_fee_amount")?;
    reader.read_bytes(REBALANCING_RANGE_BYTES, "the old and new bin ranges")?;
    let rewards = [amount(reader, "rewards[0]")?, amount(reader, "rewards[1]")?];
    Ok(Rebalanced {
        lb_pair,
        position,
        owner,
        active_bin_id,
        x_withdrawn_amount,
        x_added_amount,
        y_withdrawn_amount,
        y_added_amount,
        x_fee_amount,
        y_fee_amount,
        rewards,
    })
}

fn fee_claimed(reader: &mut ByteReader<'_>) -> Result<FeeClaimed, MalformedBytes> {
    Ok(FeeClaimed {
        lb_pair: reader.read_address("lb_pair")?,
        position: reader.read_address("position")?,
        owner: reader.read_address("owner")?,
        fee_x: amount(reader, "fee_x")?,
        fee_y: amount(reader, "fee_y")?,
    })
}

fn reward_claimed(reader: &mut ByteReader<'_>) -> Result<RewardClaimed, MalformedBytes> {
    Ok(RewardClaimed {
        lb_pair: reader.read_address("lb_pair")?,
        position: reader.read_address("position")?,
        owner: reader.read_address("owner")?,
        reward_index: reader.read_u64("reward_index")?,
        total_reward: amount(reader, "total_reward")?,
    })
}

/// `Swap`: pool, sender, bins, then the amounts, then the direction.
fn swapped(reader: &mut ByteReader<'_>) -> Result<Swapped, MalformedBytes> {
    let (lb_pair, from, start_bin_id, end_bin_id) = swap_header(reader)?;
    Ok(Swapped {
        lb_pair,
        from,
        start_bin_id,
        end_bin_id,
        amount_in: amount(reader, "amount_in")?,
        amount_out: amount(reader, "amount_out")?,
        swap_for_y: reader.read_bool("swap_for_y")?,
    })
}

/// `Swap2Evt`: pool, sender, bins, then the direction and the fee rate before the amounts.
fn swapped_second_form(reader: &mut ByteReader<'_>) -> Result<Swapped, MalformedBytes> {
    let (lb_pair, from, start_bin_id, end_bin_id) = swap_header(reader)?;
    let swap_for_y = reader.read_bool("swap_for_y")?;
    reader.read_u128("fee_bps")?;
    let amount_in = amount(reader, "amount_in")?;
    reader.read_u64("amount_left")?;
    Ok(Swapped {
        lb_pair,
        from,
        start_bin_id,
        end_bin_id,
        amount_in,
        amount_out: amount(reader, "amount_out")?,
        swap_for_y,
    })
}

fn swap_header(
    reader: &mut ByteReader<'_>,
) -> Result<(Address, Address, i32, i32), MalformedBytes> {
    Ok((
        reader.read_address("lb_pair")?,
        reader.read_address("from")?,
        reader.read_i32("start_bin_id")?,
        reader.read_i32("end_bin_id")?,
    ))
}

/// `PlaceLimitOrderEvt`, whose parameters end with the amount placed in each bin.
fn limit_order_placed(reader: &mut ByteReader<'_>) -> Result<LimitOrderPlaced, MalformedBytes> {
    let lb_pair = reader.read_address("lb_pair")?;
    let sender = reader.read_address("sender")?;
    let owner = reader.read_address("owner")?;
    let limit_order = reader.read_address("limit_order")?;
    let active_id = reader.read_i32("active_id")?;
    let is_ask_side = reader.read_bool("params.is_ask_side")?;
    reader.read_bytes(LIMIT_ORDER_PADDING_BYTES, "params.padding")?;
    if reader.read_bool("the presence of params.relative_bin")? {
        reader.read_bytes(RELATIVE_BIN_BYTES, "params.relative_bin")?;
    }
    Ok(LimitOrderPlaced {
        lb_pair,
        sender,
        owner,
        limit_order,
        active_id,
        is_ask_side,
        total_amount: total_of_bins(reader)?,
    })
}

/// The sum of the amounts of a Borsh list of `(bin id: i32, amount: u64)`.
fn total_of_bins(reader: &mut ByteReader<'_>) -> Result<RawTokenAmount, MalformedBytes> {
    let count = reader.read_u32("the number of params.bins")?;
    let mut total: u128 = 0;
    for _ in 0..count {
        reader.read_i32("params.bins[].id")?;
        let value = reader.read_u64("params.bins[].amount")?;
        total = total
            .checked_add(u128::from(value))
            .ok_or(MalformedBytes::TooLarge {
                what: "the total of params.bins",
            })?;
    }
    Ok(RawTokenAmount(total))
}

fn position_length_changed(
    reader: &mut ByteReader<'_>,
) -> Result<PositionLengthChanged, MalformedBytes> {
    Ok(PositionLengthChanged {
        lb_pair: reader.read_address("lb_pair")?,
        position: reader.read_address("position")?,
        owner: reader.read_address("owner")?,
        length: reader.read_u16("length")?,
        side: reader.read_u8("side")?,
    })
}
