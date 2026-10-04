//! The addresses of the Solana programs binsight reads instructions of.
//!
//! Each address is written as its 32 bytes, so it is a constant, and a test checks it against its
//! base58 form. This module only names the programs; their instructions are decoded in
//! [`crate::programs`].

use crate::Address;

/// The System program, `11111111111111111111111111111111`: SOL transfers and account creation.
pub const SYSTEM_PROGRAM: Address = Address::from_bytes([0; 32]);

/// The SPL Token program, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.
pub const TOKEN_PROGRAM: Address = Address::from_bytes([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);

/// The Token-2022 program, `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`: SPL Token plus
/// extensions such as transfer fees.
pub const TOKEN_2022_PROGRAM: Address = Address::from_bytes([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77,
    131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
]);

/// The Associated Token Account program, `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`.
pub const ASSOCIATED_TOKEN_PROGRAM: Address = Address::from_bytes([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218,
    255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
]);

/// The Compute Budget program, `ComputeBudget111111111111111111111111111111`.
pub const COMPUTE_BUDGET_PROGRAM: Address = Address::from_bytes([
    3, 6, 70, 111, 229, 33, 23, 50, 255, 236, 173, 186, 114, 195, 155, 231, 188, 140, 229, 187,
    197, 247, 18, 107, 44, 67, 155, 58, 64, 0, 0, 0,
]);

/// The Ed25519 signature-verification precompile, `Ed25519SigVerify111111111111111111111111111`.
pub const ED25519_PROGRAM: Address = Address::from_bytes([
    3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116, 73, 39,
    244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
]);

/// The secp256k1 signature-verification precompile, `KeccakSecp256k11111111111111111111111111111`.
pub const SECP256K1_PROGRAM: Address = Address::from_bytes([
    4, 198, 252, 32, 240, 80, 204, 240, 85, 132, 215, 33, 28, 159, 140, 245, 158, 193, 71, 133,
    187, 22, 106, 30, 40, 48, 232, 18, 32, 0, 0, 0,
]);

/// The secp256r1 signature-verification precompile, `Secp256r1SigVerify1111111111111111111111111`.
pub const SECP256R1_PROGRAM: Address = Address::from_bytes([
    6, 146, 13, 236, 47, 234, 113, 181, 183, 35, 129, 77, 116, 45, 169, 3, 28, 131, 231, 95, 219,
    121, 93, 86, 142, 117, 71, 128, 32, 0, 0, 0,
]);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_program_address_matches_its_base58_form() {
        let programs = [
            (SYSTEM_PROGRAM, "11111111111111111111111111111111"),
            (TOKEN_PROGRAM, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            (
                TOKEN_2022_PROGRAM,
                "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            ),
            (
                ASSOCIATED_TOKEN_PROGRAM,
                "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
            ),
            (
                COMPUTE_BUDGET_PROGRAM,
                "ComputeBudget111111111111111111111111111111",
            ),
            (
                ED25519_PROGRAM,
                "Ed25519SigVerify111111111111111111111111111",
            ),
            (
                SECP256K1_PROGRAM,
                "KeccakSecp256k11111111111111111111111111111",
            ),
            (
                SECP256R1_PROGRAM,
                "Secp256r1SigVerify1111111111111111111111111",
            ),
        ];
        for (address, text) in programs {
            assert_eq!(address.to_string(), text);
        }
    }
}
