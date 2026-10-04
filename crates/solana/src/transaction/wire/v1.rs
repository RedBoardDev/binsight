//! The version 1 layout (SIMD-0385): version byte first, fixed-size counts, signatures last.
//!
//! ```text
//! 0x81 | header (3 × u8) | config mask (u32 LE) | lifetime (32) | instruction count (u8)
//!      | address count (u8) | addresses (32 each) | config values (4 bytes per mask bit)
//!      | instruction headers (program u8, account count u8, data length u16 LE)
//!      | instruction payloads (account indexes, then data) | signatures (64 each)
//! ```
//!
//! The config values follow the mask bits in ascending order. Bits 0 and 1 together hold the
//! priority fee as a total in lamports (u64 LE); bit 2 the compute-unit limit, bit 3 the loaded
//! accounts data size limit and bit 4 the heap size (u32 LE each). A version 1 transaction has no
//! lookup tables. This module only reads bytes.

use binsight_core::units::Lamports;

use super::{CompiledInstruction, MessageHeader, TransactionConfig, WireFormat, WireTransaction};
use crate::byte_reader::ByteReader;
use crate::error::MalformedBytes;
use crate::transaction::error::TransactionReadError;
use crate::{Address, Signature};

/// Bits 0 and 1: the priority fee, which takes two 4-byte slots.
const PRIORITY_FEE_BITS: u32 = 0b11;

/// Bit 2: the compute-unit limit.
const COMPUTE_UNIT_LIMIT_BIT: u32 = 0b100;

/// Bit 3: the loaded accounts data size limit.
const LOADED_ACCOUNTS_DATA_SIZE_BIT: u32 = 0b1000;

/// Bit 4: the heap size.
const HEAP_SIZE_BIT: u32 = 0b1_0000;

/// Every bit binsight knows; a mask with another bit set cannot be read safely, because the
/// offsets of everything after the config values depend on it.
const KNOWN_CONFIG_BITS: u32 =
    PRIORITY_FEE_BITS | COMPUTE_UNIT_LIMIT_BIT | LOADED_ACCOUNTS_DATA_SIZE_BIT | HEAP_SIZE_BIT;

/// The shape of one instruction, read before its payload.
struct InstructionHeader {
    program_index: u8,
    account_count: u8,
    data_length: u16,
}

/// Reads a version 1 transaction, version byte included.
pub(super) fn parse(bytes: &[u8]) -> Result<WireTransaction, TransactionReadError> {
    let mut reader = ByteReader::new(bytes);
    reader.read_u8("the transaction version")?;
    let header = MessageHeader {
        required_signatures: reader.read_u8("the number of required signatures")?,
        readonly_signed: reader.read_u8("the number of read-only signers")?,
        readonly_unsigned: reader.read_u8("the number of read-only accounts")?,
    };
    let mask = reader.read_u32("the config mask")?;
    reader.read_array::<32>("the lifetime specifier")?;
    let instruction_count = reader.read_u8("the instruction count")?;
    let address_count = reader.read_u8("the address count")?;
    let static_keys = (0..address_count)
        .map(|_| reader.read_address("an account address"))
        .collect::<Result<Vec<Address>, _>>()?;
    let config = read_config(&mut reader, mask)?;
    let headers = (0..instruction_count)
        .map(|_| read_instruction_header(&mut reader))
        .collect::<Result<Vec<_>, _>>()?;
    let instructions = headers
        .iter()
        .map(|header| read_instruction_payload(&mut reader, header))
        .collect::<Result<Vec<_>, _>>()?;
    let signatures = (0..header.required_signatures)
        .map(|_| reader.read_array("a signature").map(Signature::from_bytes))
        .collect::<Result<Vec<_>, _>>()?;
    reader.finish("the transaction")?;
    Ok(WireTransaction {
        signatures,
        header,
        static_keys,
        instructions,
        format: WireFormat::V1 { config },
    })
}

fn read_config(
    reader: &mut ByteReader<'_>,
    mask: u32,
) -> Result<TransactionConfig, TransactionReadError> {
    if mask & !KNOWN_CONFIG_BITS != 0 {
        return Err(TransactionReadError::UnknownConfigBits { mask });
    }
    let priority_bits = mask & PRIORITY_FEE_BITS;
    if priority_bits != 0 && priority_bits != PRIORITY_FEE_BITS {
        return Err(TransactionReadError::SplitPriorityFee { mask });
    }
    let read_if = |reader: &mut ByteReader<'_>, bit: u32, what| {
        (mask & bit != 0).then(|| reader.read_u32(what)).transpose()
    };
    Ok(TransactionConfig {
        priority_fee: (priority_bits != 0)
            .then(|| reader.read_u64("the priority fee").map(Lamports))
            .transpose()?,
        compute_unit_limit: read_if(reader, COMPUTE_UNIT_LIMIT_BIT, "the compute-unit limit")?,
        loaded_accounts_data_size_limit: read_if(
            reader,
            LOADED_ACCOUNTS_DATA_SIZE_BIT,
            "the loaded accounts data size limit",
        )?,
        heap_size: read_if(reader, HEAP_SIZE_BIT, "the heap size")?,
    })
}

fn read_instruction_header(
    reader: &mut ByteReader<'_>,
) -> Result<InstructionHeader, MalformedBytes> {
    Ok(InstructionHeader {
        program_index: reader.read_u8("the program index of an instruction")?,
        account_count: reader.read_u8("the account count of an instruction")?,
        data_length: reader.read_u16("the data length of an instruction")?,
    })
}

fn read_instruction_payload(
    reader: &mut ByteReader<'_>,
    header: &InstructionHeader,
) -> Result<CompiledInstruction, MalformedBytes> {
    let account_indexes = reader.read_bytes(
        usize::from(header.account_count),
        "the accounts of an instruction",
    )?;
    let data = reader.read_bytes(
        usize::from(header.data_length),
        "the data of an instruction",
    )?;
    Ok(CompiledInstruction {
        program_index: header.program_index,
        account_indexes: account_indexes.to_vec(),
        data: data.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A version 1 transaction with one signer, one program and one instruction, and `mask` with
    /// its `config_values`.
    fn transaction(mask: u32, config_values: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0x81, 1, 0, 1];
        bytes.extend(mask.to_le_bytes());
        bytes.extend([9; 32]);
        bytes.extend([1, 2]);
        bytes.extend([5; 32]);
        bytes.extend([6; 32]);
        bytes.extend(config_values);
        bytes.extend([1, 1]);
        bytes.extend(3_u16.to_le_bytes());
        bytes.extend([0, 7, 8, 9]);
        bytes.extend([4; 64]);
        bytes
    }

    #[test]
    fn reads_the_config_values_in_the_order_of_their_bits() {
        let mut values = Vec::new();
        values.extend(1_000_u64.to_le_bytes());
        values.extend(200_000_u32.to_le_bytes());
        values.extend(32_768_u32.to_le_bytes());
        let parsed = parse(&transaction(0b1_0111, &values)).unwrap();
        let WireFormat::V1 { config } = parsed.format else {
            panic!("expected version 1, got {:?}", parsed.format);
        };
        assert_eq!(
            config,
            TransactionConfig {
                priority_fee: Some(Lamports(1_000)),
                compute_unit_limit: Some(200_000),
                loaded_accounts_data_size_limit: None,
                heap_size: Some(32_768),
            }
        );
        assert_eq!(parsed.signatures, [Signature::from_bytes([4; 64])]);
        assert_eq!(
            parsed.instructions,
            [CompiledInstruction {
                program_index: 1,
                account_indexes: vec![0],
                data: vec![7, 8, 9],
            }]
        );
    }

    #[test]
    fn reads_the_header_of_a_real_version_1_transaction() {
        use base64::Engine;
        let answer: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../tests/fixtures/mainnet/v1-rebalance-liquidity/tx-1.json"
        ))
        .unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(answer["transaction"][0].as_str().unwrap())
            .unwrap();
        let parsed = parse(&bytes).unwrap();
        // The values the node shows as `transactionConfig` with the `json` encoding.
        assert_eq!(
            parsed.format,
            WireFormat::V1 {
                config: TransactionConfig {
                    priority_fee: Some(Lamports(1_000)),
                    compute_unit_limit: Some(204_412),
                    loaded_accounts_data_size_limit: Some(67_108_864),
                    heap_size: None,
                }
            }
        );
        assert_eq!(parsed.signatures.len(), 1);
    }

    #[test]
    fn treats_an_absent_config_value_as_not_requested() {
        let parsed = parse(&transaction(0, &[])).unwrap();
        assert_eq!(
            parsed.format,
            WireFormat::V1 {
                config: TransactionConfig::default()
            }
        );
    }

    #[test]
    fn refuses_a_priority_fee_announced_by_only_one_of_its_bits() {
        let error = parse(&transaction(0b01, &[0; 4])).unwrap_err();
        assert!(matches!(
            error,
            TransactionReadError::SplitPriorityFee { mask: 1 }
        ));
    }

    #[test]
    fn refuses_a_config_bit_it_does_not_know() {
        let error = parse(&transaction(0b10_0000, &[0; 4])).unwrap_err();
        assert!(matches!(
            error,
            TransactionReadError::UnknownConfigBits { mask: 32 }
        ));
    }

    #[test]
    fn refuses_bytes_after_the_signatures() {
        let mut bytes = transaction(0, &[]);
        bytes.push(0);
        let error = parse(&bytes).unwrap_err();
        assert!(matches!(
            error,
            TransactionReadError::Malformed(MalformedBytes::TrailingBytes { count: 1, .. })
        ));
    }
}
