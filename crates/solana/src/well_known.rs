//! The addresses of the Solana programs binsight reads instructions of, and of the few accounts
//! whose role is fixed (the wrapped SOL and canonical stable mints).
//!
//! Each address is written as its 32 bytes, so it is a constant, and a test checks it against its
//! base58 form. Mint identities establish no decimals, token program or valuation. Program
//! instructions are decoded in [`crate::programs`].

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

/// The Memo program, `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`: attaches a note, moves nothing.
pub const MEMO_PROGRAM: Address = Address::from_bytes([
    5, 74, 83, 90, 153, 41, 33, 6, 77, 36, 232, 113, 96, 218, 56, 124, 124, 53, 181, 221, 188, 146,
    187, 129, 228, 31, 168, 64, 65, 5, 68, 141,
]);

/// The first Memo program, `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`.
pub const MEMO_V1_PROGRAM: Address = Address::from_bytes([
    5, 74, 83, 80, 248, 93, 200, 130, 214, 20, 165, 86, 114, 120, 138, 41, 109, 223, 30, 171, 171,
    208, 166, 6, 120, 136, 73, 50, 244, 238, 246, 160,
]);

/// The Lighthouse program, `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`: wallets add its
/// assertions to a transaction (balances, owners), and it moves nothing.
pub const LIGHTHOUSE_PROGRAM: Address = Address::from_bytes([
    4, 223, 173, 121, 98, 255, 177, 221, 146, 93, 10, 159, 181, 230, 208, 12, 230, 25, 91, 168,
    187, 58, 145, 253, 7, 239, 152, 96, 197, 233, 123, 184,
]);

/// The mint of wrapped SOL, `So11111111111111111111111111111111111111112`: a token account of this
/// mint holds its tokens as lamports, above its rent.
pub const WSOL_MINT: Address = Address::from_bytes([
    6, 155, 136, 87, 254, 171, 129, 132, 251, 104, 127, 99, 70, 24, 192, 53, 218, 196, 57, 220, 26,
    235, 59, 85, 152, 160, 240, 0, 0, 0, 0, 1,
]);

/// Circle's mainnet Solana USDC mint, as listed in its
/// [contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).
pub const USDC_MINT: Address = Address::from_bytes([
    198, 250, 122, 243, 190, 219, 173, 58, 61, 101, 243, 106, 171, 201, 116, 49, 177, 187, 228,
    194, 210, 246, 224, 228, 124, 166, 2, 3, 69, 47, 93, 97,
]);

/// Tether's mainnet Solana USDT mint, as listed in its
/// [supported protocols](https://tether.to/en/supported-protocols/).
pub const USDT_MINT: Address = Address::from_bytes([
    206, 1, 14, 96, 175, 237, 178, 39, 23, 189, 99, 25, 47, 84, 20, 90, 63, 150, 90, 51, 187, 130,
    210, 199, 2, 158, 178, 206, 30, 32, 130, 100,
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
            (MEMO_PROGRAM, "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
            (
                MEMO_V1_PROGRAM,
                "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
            ),
            (
                LIGHTHOUSE_PROGRAM,
                "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95",
            ),
        ];
        for (address, text) in programs {
            assert_eq!(address.to_string(), text);
        }
    }

    #[test]
    fn every_account_address_matches_its_base58_form() {
        assert_eq!(
            WSOL_MINT.to_string(),
            "So11111111111111111111111111111111111111112"
        );
        assert_eq!(
            USDC_MINT.to_string(),
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        );
        assert_eq!(
            USDT_MINT.to_string(),
            "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
        );
    }
}
