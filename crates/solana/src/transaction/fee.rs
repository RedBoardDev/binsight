//! The fee of a transaction, split into its signature part and its priority part.
//!
//! The node reports only the total. The priority part is what the transaction asked for: in its
//! header for version 1 (a total in lamports), or with Compute Budget instructions for legacy and
//! version 0 (a price per compute unit, in micro-lamports, times the limit, rounded up like the
//! runtime). When a legacy or version 0 transaction sets a price without a limit, the limit the
//! runtime chose is not recorded anywhere; the priority part is then what is left after
//! [`LAMPORTS_PER_SIGNATURE`] per signature. The base part is always the total minus the
//! priority part. This module computes the split; it does not decide who pays.

use binsight_core::units::Lamports;

use super::InstructionNode;
use super::error::TransactionReadError;
use super::wire::WireFormat;
use crate::programs::{self, ComputeBudgetInstruction, ProgramInstruction};
use crate::well_known::{
    COMPUTE_BUDGET_PROGRAM, ED25519_PROGRAM, SECP256K1_PROGRAM, SECP256R1_PROGRAM,
};

/// The fee charged per signature (transaction and precompile signatures alike).
pub const LAMPORTS_PER_SIGNATURE: Lamports = Lamports(5_000);

/// A compute-unit price is in micro-lamports.
const MICRO_LAMPORTS_PER_LAMPORT: u128 = 1_000_000;

/// The runtime never grants more compute units than this, whatever the request.
const MAX_COMPUTE_UNIT_LIMIT: u32 = 1_400_000;

/// The fee of a transaction and its two parts; `base + priority = total`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeBreakdown {
    /// The fee charged.
    pub total: Lamports,
    /// The signature part.
    pub base: Lamports,
    /// The priority part, paid to be scheduled first.
    pub priority: Lamports,
}

/// What a transaction asked to pay for priority.
enum PriorityRequest {
    /// The request fixes the amount.
    Exact(Lamports),
    /// A price without a limit: the amount depends on a limit the runtime chose.
    PriceWithoutLimit,
}

/// Splits the fee `total` of a transaction with `required_signatures` signers.
pub(super) fn breakdown(
    total: Lamports,
    format: &WireFormat,
    instructions: &[InstructionNode],
    required_signatures: u8,
) -> Result<FeeBreakdown, TransactionReadError> {
    let request = match format {
        WireFormat::V1 { config } => {
            PriorityRequest::Exact(config.priority_fee.unwrap_or(Lamports::ZERO))
        }
        WireFormat::Legacy | WireFormat::V0 { .. } => compute_budget_request(instructions),
    };
    let priority = match request {
        PriorityRequest::Exact(priority) => priority,
        PriorityRequest::PriceWithoutLimit => {
            let signatures = signature_count(instructions, required_signatures);
            let signature_fee = Lamports(LAMPORTS_PER_SIGNATURE.0.saturating_mul(signatures));
            total
                .try_sub(signature_fee)
                .map_err(|_| fee_too_small("signature", total, signature_fee))?
        }
    };
    let base = total
        .try_sub(priority)
        .map_err(|_| fee_too_small("priority", total, priority))?;
    Ok(FeeBreakdown {
        total,
        base,
        priority,
    })
}

fn fee_too_small(part: &'static str, total: Lamports, expected: Lamports) -> TransactionReadError {
    TransactionReadError::FeeTooSmall {
        part,
        total,
        expected,
    }
}

/// The priority fee the top-level Compute Budget instructions ask for.
///
/// A repeated or malformed instruction makes the runtime refuse the request, so the amount then
/// falls back to the signature count, like a price without a limit.
fn compute_budget_request(instructions: &[InstructionNode]) -> PriorityRequest {
    let mut price = None;
    let mut limit = None;
    let top_level_budget = instructions.iter().filter(|instruction| {
        instruction.position.inner.is_none() && instruction.program == COMPUTE_BUDGET_PROGRAM
    });
    for instruction in top_level_budget {
        let decoded = match programs::decode(instruction) {
            Ok(Some(ProgramInstruction::ComputeBudget(decoded))) => decoded,
            Ok(_) => continue,
            Err(_) => return PriorityRequest::PriceWithoutLimit,
        };
        let is_repeated = match decoded {
            ComputeBudgetInstruction::SetComputeUnitPrice { micro_lamports } => {
                price.replace(micro_lamports).is_some()
            }
            ComputeBudgetInstruction::SetComputeUnitLimit { units } => {
                limit.replace(units).is_some()
            }
            _ => false,
        };
        if is_repeated {
            return PriorityRequest::PriceWithoutLimit;
        }
    }
    match (price, limit) {
        (None | Some(0), _) => PriorityRequest::Exact(Lamports::ZERO),
        (Some(_), None) => PriorityRequest::PriceWithoutLimit,
        (Some(price), Some(limit)) => {
            let units = u128::from(limit.min(MAX_COMPUTE_UNIT_LIMIT));
            u128::from(price)
                .checked_mul(units)
                .map(|micro_lamports| micro_lamports.div_ceil(MICRO_LAMPORTS_PER_LAMPORT))
                .and_then(|lamports| u64::try_from(lamports).ok())
                .map_or(PriorityRequest::PriceWithoutLimit, |lamports| {
                    PriorityRequest::Exact(Lamports(lamports))
                })
        }
    }
}

/// The signatures the fee is charged for: the transaction's, plus those its top-level
/// instructions ask a signature-verification precompile to check (the first data byte).
fn signature_count(instructions: &[InstructionNode], required_signatures: u8) -> u64 {
    let precompile_signatures = instructions
        .iter()
        .filter(|instruction| {
            instruction.position.inner.is_none()
                && [ED25519_PROGRAM, SECP256K1_PROGRAM, SECP256R1_PROGRAM]
                    .contains(&instruction.program)
        })
        .filter_map(|instruction| instruction.data.as_bytes().first())
        .map(|&count| u64::from(count));
    precompile_signatures.fold(u64::from(required_signatures), u64::saturating_add)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Address;
    use crate::transaction::{InstructionData, InstructionPosition};

    fn top_level(top: u16, program: Address, data: Vec<u8>) -> InstructionNode {
        InstructionNode {
            position: InstructionPosition { top, inner: None },
            stack_height: Some(1),
            program,
            accounts: Vec::new(),
            data: InstructionData(data),
        }
    }

    fn price(micro_lamports: u64) -> Vec<u8> {
        let mut data = vec![3];
        data.extend(micro_lamports.to_le_bytes());
        data
    }

    fn limit(units: u32) -> Vec<u8> {
        let mut data = vec![2];
        data.extend(units.to_le_bytes());
        data
    }

    #[test]
    fn rounds_the_priority_fee_up_to_the_next_lamport() {
        let instructions = [
            top_level(0, COMPUTE_BUDGET_PROGRAM, price(133_333_334)),
            top_level(1, COMPUTE_BUDGET_PROGRAM, limit(562)),
        ];
        let fee = breakdown(Lamports(79_934), &WireFormat::Legacy, &instructions, 1).unwrap();
        assert_eq!(fee.priority, Lamports(74_934));
        assert_eq!(fee.base, Lamports(5_000));
    }

    #[test]
    fn caps_the_limit_at_the_runtime_maximum() {
        let instructions = [
            top_level(0, COMPUTE_BUDGET_PROGRAM, limit(u32::MAX)),
            top_level(1, COMPUTE_BUDGET_PROGRAM, price(1_000_000)),
        ];
        let fee = breakdown(Lamports(1_405_000), &WireFormat::Legacy, &instructions, 1).unwrap();
        assert_eq!(fee.priority, Lamports(1_400_000));
    }

    #[test]
    fn derives_the_priority_from_the_signatures_when_no_limit_is_set() {
        let mut verify = vec![2];
        verify.extend([0; 14]);
        let instructions = [
            top_level(0, COMPUTE_BUDGET_PROGRAM, price(10)),
            top_level(1, ED25519_PROGRAM, verify),
        ];
        let fee = breakdown(Lamports(15_123), &WireFormat::Legacy, &instructions, 1).unwrap();
        assert_eq!(fee.base, Lamports(15_000));
        assert_eq!(fee.priority, Lamports(123));
    }

    #[test]
    fn refuses_a_fee_below_its_priority_part() {
        let instructions = [
            top_level(0, COMPUTE_BUDGET_PROGRAM, price(1_000_000)),
            top_level(1, COMPUTE_BUDGET_PROGRAM, limit(10_000)),
        ];
        let error = breakdown(Lamports(5_000), &WireFormat::Legacy, &instructions, 1).unwrap_err();
        assert!(matches!(
            error,
            TransactionReadError::FeeTooSmall {
                part: "priority",
                ..
            }
        ));
    }
}
