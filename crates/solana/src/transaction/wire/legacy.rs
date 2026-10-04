//! The legacy and version 0 layouts: signatures first, then the message.
//!
//! Every count is a compact-u16. A version 0 message starts with `0x80` and ends with its address
//! lookup tables; a legacy message has neither. This module only reads bytes; the accounts the
//! lookup tables load are resolved from the meta elsewhere.

use super::{
    CompiledInstruction, LookupTableUse, MessageHeader, VERSION_PREFIX, WireFormat, WireTransaction,
};
use crate::byte_reader::ByteReader;
use crate::error::MalformedBytes;
use crate::transaction::error::TransactionReadError;
use crate::transaction::version::TxVersion;
use crate::{Address, Signature};

/// The message versions this layout can hold.
enum MessageVersion {
    Legacy,
    V0,
}

/// Reads a legacy or version 0 transaction.
pub(super) fn parse(bytes: &[u8]) -> Result<WireTransaction, TransactionReadError> {
    let mut reader = ByteReader::new(bytes);
    let signatures = read_signatures(&mut reader)?;
    let version = read_message_version(&mut reader)?;
    let header = MessageHeader {
        required_signatures: reader.read_u8("the number of required signatures")?,
        readonly_signed: reader.read_u8("the number of read-only signers")?,
        readonly_unsigned: reader.read_u8("the number of read-only accounts")?,
    };
    let static_keys = read_addresses(&mut reader)?;
    reader.read_array::<32>("the recent blockhash")?;
    let instructions = read_instructions(&mut reader)?;
    let format = match version {
        MessageVersion::Legacy => WireFormat::Legacy,
        MessageVersion::V0 => WireFormat::V0 {
            lookups: read_lookups(&mut reader)?,
        },
    };
    reader.finish("the transaction")?;
    Ok(WireTransaction {
        signatures,
        header,
        static_keys,
        instructions,
        format,
    })
}

fn read_signatures(reader: &mut ByteReader<'_>) -> Result<Vec<Signature>, MalformedBytes> {
    let count = reader.read_compact_u16("the signature count")?;
    (0..count)
        .map(|_| reader.read_array("a signature").map(Signature::from_bytes))
        .collect()
}

/// Reads the version prefix of a versioned message, or leaves a legacy message untouched.
fn read_message_version(
    reader: &mut ByteReader<'_>,
) -> Result<MessageVersion, TransactionReadError> {
    let prefix = reader.peek_u8("the message")?;
    if prefix & VERSION_PREFIX == 0 {
        return Ok(MessageVersion::Legacy);
    }
    reader.read_u8("the message version")?;
    match TxVersion::try_from(prefix & !VERSION_PREFIX)? {
        TxVersion::V0 => Ok(MessageVersion::V0),
        // Version 1 has its own layout, which starts with its version byte, not signatures.
        version @ (TxVersion::Legacy | TxVersion::V1) => {
            Err(TransactionReadError::MisplacedVersion { version })
        }
    }
}

fn read_addresses(reader: &mut ByteReader<'_>) -> Result<Vec<Address>, MalformedBytes> {
    let count = reader.read_compact_u16("the account count")?;
    (0..count)
        .map(|_| reader.read_address("an account address"))
        .collect()
}

fn read_instructions(
    reader: &mut ByteReader<'_>,
) -> Result<Vec<CompiledInstruction>, MalformedBytes> {
    let count = reader.read_compact_u16("the instruction count")?;
    (0..count)
        .map(|_| {
            let program_index = reader.read_u8("the program index of an instruction")?;
            let account_indexes = read_byte_vector(reader, "the accounts of an instruction")?;
            let data = read_byte_vector(reader, "the data of an instruction")?;
            Ok(CompiledInstruction {
                program_index,
                account_indexes,
                data,
            })
        })
        .collect()
}

fn read_lookups(reader: &mut ByteReader<'_>) -> Result<Vec<LookupTableUse>, MalformedBytes> {
    let count = reader.read_compact_u16("the lookup table count")?;
    (0..count)
        .map(|_| {
            Ok(LookupTableUse {
                table: reader.read_address("a lookup table address")?,
                writable_indexes: read_byte_vector(reader, "the writable lookup indexes")?,
                readonly_indexes: read_byte_vector(reader, "the read-only lookup indexes")?,
            })
        })
        .collect()
}

/// A compact-u16 length followed by that many bytes.
fn read_byte_vector(
    reader: &mut ByteReader<'_>,
    what: &'static str,
) -> Result<Vec<u8>, MalformedBytes> {
    let length = reader.read_compact_u16(what)?;
    reader
        .read_bytes(usize::from(length), what)
        .map(<[u8]>::to_vec)
}
