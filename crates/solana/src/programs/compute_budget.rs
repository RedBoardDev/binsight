//! The Compute Budget program: the compute-unit limit and price of a legacy or version 0
//! transaction.
//!
//! The data is Borsh: a `u8` discriminator, then little-endian fields. The runtime refuses extra
//! bytes, so the decoder does too. A version 1 transaction carries these values in its header
//! instead and the runtime ignores these instructions there. This module only decodes.

use binsight_core::units::Lamports;

use super::InstructionDecodeError;
use super::instruction_reader::InstructionFields;

/// The name used in errors.
const PROGRAM: &str = "Compute Budget";

const REQUEST_UNITS_DEPRECATED: u8 = 0;
const REQUEST_HEAP_FRAME: u8 = 1;
const SET_COMPUTE_UNIT_LIMIT: u8 = 2;
const SET_COMPUTE_UNIT_PRICE: u8 = 3;
const SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT: u8 = 4;

/// A Compute Budget instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputeBudgetInstruction {
    /// The first way to pay for priority (2022), replaced by the limit and price instructions:
    /// a compute-unit limit and a fee added to the signature fee.
    RequestUnitsDeprecated {
        /// The compute-unit limit.
        units: u32,
        /// The fee added to the signature fee.
        additional_fee: Lamports,
    },
    /// Requests a heap.
    RequestHeapFrame {
        /// Its size.
        bytes: u32,
    },
    /// Sets the compute-unit limit.
    SetComputeUnitLimit {
        /// The limit.
        units: u32,
    },
    /// Sets the price of a compute unit.
    SetComputeUnitPrice {
        /// The price, in micro-lamports (10^-6 lamport) per compute unit.
        micro_lamports: u64,
    },
    /// Sets the limit on the account data the transaction loads.
    SetLoadedAccountsDataSizeLimit {
        /// The limit.
        bytes: u32,
    },
    /// Another instruction.
    Other {
        /// Its discriminator.
        discriminator: u8,
    },
}

/// Decodes a Compute Budget instruction from its data.
pub(super) fn decode(data: &[u8]) -> Result<ComputeBudgetInstruction, InstructionDecodeError> {
    let mut fields = InstructionFields::new(data, PROGRAM);
    let instruction = match fields.u8("the instruction")? {
        REQUEST_UNITS_DEPRECATED => ComputeBudgetInstruction::RequestUnitsDeprecated {
            units: fields.u32("the compute-unit limit")?,
            additional_fee: Lamports(u64::from(fields.u32("the additional fee")?)),
        },
        REQUEST_HEAP_FRAME => ComputeBudgetInstruction::RequestHeapFrame {
            bytes: fields.u32("the heap size")?,
        },
        SET_COMPUTE_UNIT_LIMIT => ComputeBudgetInstruction::SetComputeUnitLimit {
            units: fields.u32("the compute-unit limit")?,
        },
        SET_COMPUTE_UNIT_PRICE => ComputeBudgetInstruction::SetComputeUnitPrice {
            micro_lamports: fields.u64("the compute-unit price")?,
        },
        SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT => {
            ComputeBudgetInstruction::SetLoadedAccountsDataSizeLimit {
                bytes: fields.u32("the data size limit")?,
            }
        }
        discriminator => return Ok(ComputeBudgetInstruction::Other { discriminator }),
    };
    fields.finish("a compute budget instruction")?;
    Ok(instruction)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_price_in_micro_lamports() {
        let mut data = vec![SET_COMPUTE_UNIT_PRICE];
        data.extend(133_333_334_u64.to_le_bytes());
        assert_eq!(
            decode(&data),
            Ok(ComputeBudgetInstruction::SetComputeUnitPrice {
                micro_lamports: 133_333_334
            })
        );
    }

    #[test]
    fn decodes_the_deprecated_request_with_its_additional_fee() {
        let mut data = vec![REQUEST_UNITS_DEPRECATED];
        data.extend(400_000_u32.to_le_bytes());
        data.extend(12_345_u32.to_le_bytes());
        assert_eq!(
            decode(&data),
            Ok(ComputeBudgetInstruction::RequestUnitsDeprecated {
                units: 400_000,
                additional_fee: Lamports(12_345),
            })
        );
    }

    #[test]
    fn refuses_extra_bytes_like_the_runtime() {
        let data = [SET_COMPUTE_UNIT_LIMIT, 1, 0, 0, 0, 0];
        assert!(decode(&data).is_err());
    }
}
