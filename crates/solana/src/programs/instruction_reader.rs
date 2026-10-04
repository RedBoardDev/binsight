//! Reading the accounts and the data fields of an instruction, with errors naming the program.
//!
//! Every decoder reads its accounts by position and its fields in order; these two readers turn a
//! missing account or a short field into an [`InstructionDecodeError`] that says which program and
//! which instruction it was. This module knows no instruction layout.

use super::InstructionDecodeError;
use crate::Address;
use crate::byte_reader::ByteReader;
use crate::error::MalformedBytes;

/// The accounts of an instruction, read by position.
pub(super) struct InstructionAccounts<'a> {
    accounts: &'a [Address],
    program: &'static str,
    instruction: &'static str,
}

impl<'a> InstructionAccounts<'a> {
    /// The `accounts` of the `instruction` of `program`.
    pub(super) fn new(
        accounts: &'a [Address],
        program: &'static str,
        instruction: &'static str,
    ) -> Self {
        Self {
            accounts,
            program,
            instruction,
        }
    }

    /// The account at `position`.
    pub(super) fn at(&self, position: usize) -> Result<Address, InstructionDecodeError> {
        self.accounts
            .get(position)
            .copied()
            .ok_or_else(|| self.missing(position))
    }

    /// The last `count` accounts, all after `position` (an instruction whose accounts end with a
    /// list of variable length).
    pub(super) fn last(
        &self,
        count: usize,
        position: usize,
    ) -> Result<Vec<Address>, InstructionDecodeError> {
        let first_of_list = position.saturating_add(1);
        match self.accounts.len().checked_sub(count) {
            Some(start) if start >= first_of_list => {
                Ok(self.accounts.iter().skip(start).copied().collect())
            }
            _ => Err(self.missing(first_of_list.saturating_add(count).saturating_sub(1))),
        }
    }

    fn missing(&self, position: usize) -> InstructionDecodeError {
        InstructionDecodeError::MissingAccount {
            program: self.program,
            instruction: self.instruction,
            position,
        }
    }
}

/// The data of an instruction, read field by field.
pub(super) struct InstructionFields<'a> {
    reader: ByteReader<'a>,
    program: &'static str,
}

impl<'a> InstructionFields<'a> {
    /// The `data` of an instruction of `program`.
    pub(super) fn new(data: &'a [u8], program: &'static str) -> Self {
        Self {
            reader: ByteReader::new(data),
            program,
        }
    }

    /// One byte.
    pub(super) fn u8(&mut self, what: &'static str) -> Result<u8, InstructionDecodeError> {
        let result = self.reader.read_u8(what);
        self.checked(result)
    }

    /// A little-endian `u32`.
    pub(super) fn u32(&mut self, what: &'static str) -> Result<u32, InstructionDecodeError> {
        let result = self.reader.read_u32(what);
        self.checked(result)
    }

    /// A little-endian `u64`.
    pub(super) fn u64(&mut self, what: &'static str) -> Result<u64, InstructionDecodeError> {
        let result = self.reader.read_u64(what);
        self.checked(result)
    }

    /// A 32-byte address.
    pub(super) fn address(
        &mut self,
        what: &'static str,
    ) -> Result<Address, InstructionDecodeError> {
        let result = self.reader.read_address(what);
        self.checked(result)
    }

    /// Skips a bincode string: a `u64` length, then that many bytes.
    pub(super) fn skip_string(&mut self, what: &'static str) -> Result<(), InstructionDecodeError> {
        let offset = self.reader.offset();
        let length = self.u64(what)?;
        let result = usize::try_from(length)
            .map_err(|_| MalformedBytes::UnexpectedEnd { what, offset })
            .and_then(|length| self.reader.read_bytes(length, what));
        self.checked(result).map(|_| ())
    }

    /// Refuses data left after the fields, for programs that refuse it too.
    pub(super) fn finish(&self, what: &'static str) -> Result<(), InstructionDecodeError> {
        let result = self.reader.finish(what);
        self.checked(result)
    }

    fn checked<T>(&self, result: Result<T, MalformedBytes>) -> Result<T, InstructionDecodeError> {
        result.map_err(|source| InstructionDecodeError::Malformed {
            program: self.program,
            source,
        })
    }
}
