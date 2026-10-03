//! The identity of the Meteora DLMM program on Solana mainnet.
//!
//! This module only names the program; decoding its accounts and events comes later, in other
//! modules of this crate.

/// The address of the Meteora DLMM program, in base58.
///
/// Every DLMM pool, position and event belongs to this program.
pub const PROGRAM_ID: &str = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9t5PdRXdx";

#[cfg(test)]
mod tests {
    use binsight_solana::Address;

    use super::PROGRAM_ID;

    #[test]
    fn program_id_is_a_valid_address() {
        let address: Address = PROGRAM_ID.parse().unwrap();
        assert_eq!(address.to_string(), PROGRAM_ID);
    }
}
