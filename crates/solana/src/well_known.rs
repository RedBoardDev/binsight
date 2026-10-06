//! The addresses of the Solana programs binsight reads instructions of, and of the few accounts
//! whose role is fixed (the wrapped SOL and canonical stable mints, the Jito tip accounts).
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

/// The eight accounts Jito's block engine collects tips on: a transfer to one of them is a tip,
/// paid to have the transaction included.
pub const JITO_TIP_ACCOUNTS: [Address; 8] = [
    Address::from_bytes([
        120, 82, 28, 177, 121, 206, 187, 133, 137, 181, 86, 162, 213, 236, 148, 210, 73, 134, 130,
        253, 249, 187, 42, 245, 173, 100, 228, 145, 204, 65, 83, 218,
    ]),
    Address::from_bytes([
        241, 135, 236, 135, 209, 247, 69, 203, 58, 3, 56, 74, 38, 166, 158, 218, 12, 162, 209, 170,
        15, 65, 228, 36, 22, 55, 126, 145, 255, 91, 93, 49,
    ]),
    Address::from_bytes([
        177, 78, 13, 229, 94, 159, 186, 134, 57, 110, 191, 213, 72, 207, 248, 201, 32, 17, 234,
        199, 183, 91, 170, 155, 45, 156, 106, 134, 245, 161, 113, 65,
    ]),
    Address::from_bytes([
        136, 241, 255, 163, 162, 223, 230, 23, 189, 196, 227, 87, 50, 81, 163, 34, 227, 252, 174,
        129, 229, 164, 87, 57, 14, 100, 117, 28, 0, 164, 101, 226,
    ]),
    Address::from_bytes([
        188, 43, 87, 6, 94, 241, 221, 102, 84, 48, 190, 96, 107, 166, 89, 108, 2, 149, 48, 27, 173,
        239, 139, 90, 252, 65, 1, 65, 80, 244, 18, 116,
    ]),
    Address::from_bytes([
        137, 7, 125, 85, 165, 187, 19, 48, 118, 62, 183, 103, 245, 94, 192, 119, 180, 26, 13, 7,
        95, 125, 225, 215, 63, 186, 202, 60, 99, 213, 84, 113,
    ]),
    Address::from_bytes([
        191, 151, 27, 89, 16, 139, 91, 133, 160, 79, 176, 147, 241, 226, 27, 78, 63, 212, 196, 200,
        244, 135, 221, 9, 185, 87, 82, 118, 159, 13, 216, 195,
    ]),
    Address::from_bytes([
        32, 38, 16, 30, 194, 3, 40, 150, 74, 50, 171, 171, 19, 108, 84, 5, 185, 31, 58, 227, 142,
        228, 246, 76, 182, 189, 232, 121, 184, 104, 56, 210,
    ]),
];

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
        let tips = [
            "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
            "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
            "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
            "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
            "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
            "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
            "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
            "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
        ];
        let written: Vec<String> = JITO_TIP_ACCOUNTS.iter().map(ToString::to_string).collect();
        assert_eq!(written, tips);
    }
}
