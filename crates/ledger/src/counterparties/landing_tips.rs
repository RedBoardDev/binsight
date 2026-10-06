//! The tip accounts of the transaction-landing services.
//!
//! A landing service sends a transaction to block builders faster, for a tip: a plain SOL
//! transfer from the payer to one of its tip accounts, inside the transaction. The ledger books
//! such a transfer as an on-chain cost, `Tip`, like the network fee, never as a protocol loss or
//! a swap leg. Each service publishes its accounts; this table copies them, with the page each
//! group comes from (read on 2026-10-06), plus two former bloXroute accounts that older
//! transactions still pay. It lists inclusion tips only: payments for data feeds are not tips.

use std::collections::HashMap;
use std::sync::LazyLock;

use binsight_solana::Address;

/// A transaction-landing service that collects tips.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LandingService {
    /// Jito's block engine.
    Jito,
    /// Helius Sender.
    HeliusSender,
    /// Nozomi, by Temporal.
    Nozomi,
    /// bloXroute's Trader API.
    BloXroute,
    /// 0slot.
    ZeroSlot,
    /// The `NextBlock` service.
    NextBlock,
    /// Astralane Iris.
    Astralane,
    /// The `BlockRazor` service.
    BlockRazor,
    /// Falcon, by Corvus Labs.
    Falcon,
    /// Jupiter's transaction sender (Beam).
    JupiterBeam,
    /// Solana Vibe Station's Lightspeed.
    Lightspeed,
}

/// Every known tip account: its service, its address as the service's documentation writes it,
/// and the same address as bytes. A test checks that both forms agree.
#[rustfmt::skip]
const TIP_ACCOUNTS: [(LandingService, &str, Address); 141] = [
    // Jito's block engine: <https://docs.jito.wtf/lowlatencytxnsend/>
    (LandingService::Jito, "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", Address::from_bytes([120, 82, 28, 177, 121, 206, 187, 133, 137, 181, 86, 162, 213, 236, 148, 210, 73, 134, 130, 253, 249, 187, 42, 245, 173, 100, 228, 145, 204, 65, 83, 218])),
    (LandingService::Jito, "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe", Address::from_bytes([241, 135, 236, 135, 209, 247, 69, 203, 58, 3, 56, 74, 38, 166, 158, 218, 12, 162, 209, 170, 15, 65, 228, 36, 22, 55, 126, 145, 255, 91, 93, 49])),
    (LandingService::Jito, "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", Address::from_bytes([177, 78, 13, 229, 94, 159, 186, 134, 57, 110, 191, 213, 72, 207, 248, 201, 32, 17, 234, 199, 183, 91, 170, 155, 45, 156, 106, 134, 245, 161, 113, 65])),
    (LandingService::Jito, "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49", Address::from_bytes([136, 241, 255, 163, 162, 223, 230, 23, 189, 196, 227, 87, 50, 81, 163, 34, 227, 252, 174, 129, 229, 164, 87, 57, 14, 100, 117, 28, 0, 164, 101, 226])),
    (LandingService::Jito, "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", Address::from_bytes([188, 43, 87, 6, 94, 241, 221, 102, 84, 48, 190, 96, 107, 166, 89, 108, 2, 149, 48, 27, 173, 239, 139, 90, 252, 65, 1, 65, 80, 244, 18, 116])),
    (LandingService::Jito, "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt", Address::from_bytes([137, 7, 125, 85, 165, 187, 19, 48, 118, 62, 183, 103, 245, 94, 192, 119, 180, 26, 13, 7, 95, 125, 225, 215, 63, 186, 202, 60, 99, 213, 84, 113])),
    (LandingService::Jito, "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", Address::from_bytes([191, 151, 27, 89, 16, 139, 91, 133, 160, 79, 176, 147, 241, 226, 27, 78, 63, 212, 196, 200, 244, 135, 221, 9, 185, 87, 82, 118, 159, 13, 216, 195])),
    (LandingService::Jito, "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT", Address::from_bytes([32, 38, 16, 30, 194, 3, 40, 150, 74, 50, 171, 171, 19, 108, 84, 5, 185, 31, 58, 227, 142, 228, 246, 76, 182, 189, 232, 121, 184, 104, 56, 210])),
    // Helius Sender: <https://www.helius.dev/docs/sending-transactions/sender>
    (LandingService::HeliusSender, "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE", Address::from_bytes([46, 238, 123, 137, 42, 78, 248, 164, 74, 171, 249, 112, 204, 14, 55, 234, 247, 38, 118, 117, 23, 12, 29, 105, 156, 211, 18, 116, 73, 108, 84, 63])),
    (LandingService::HeliusSender, "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ", Address::from_bytes([178, 163, 108, 121, 4, 152, 33, 252, 36, 175, 19, 191, 139, 87, 141, 230, 88, 113, 159, 61, 101, 33, 168, 2, 94, 214, 107, 197, 72, 112, 93, 34])),
    (LandingService::HeliusSender, "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta", Address::from_bytes([127, 199, 60, 168, 30, 180, 210, 68, 130, 226, 199, 171, 92, 65, 82, 69, 233, 209, 67, 34, 123, 90, 209, 46, 70, 116, 224, 137, 137, 201, 74, 123])),
    (LandingService::HeliusSender, "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn", Address::from_bytes([66, 190, 55, 236, 58, 159, 172, 90, 18, 183, 80, 82, 128, 207, 246, 255, 66, 42, 141, 173, 80, 49, 231, 231, 187, 88, 83, 97, 127, 122, 0, 13])),
    (LandingService::HeliusSender, "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD", Address::from_bytes([26, 162, 240, 90, 111, 137, 80, 252, 191, 93, 249, 202, 57, 72, 28, 109, 241, 51, 5, 200, 184, 124, 100, 79, 77, 140, 109, 130, 11, 55, 137, 166])),
    (LandingService::HeliusSender, "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ", Address::from_bytes([27, 45, 4, 167, 98, 236, 87, 72, 30, 127, 29, 199, 252, 220, 152, 100, 45, 220, 197, 125, 88, 132, 12, 178, 227, 255, 32, 80, 114, 89, 8, 155])),
    (LandingService::HeliusSender, "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF", Address::from_bytes([14, 21, 185, 85, 244, 252, 210, 15, 121, 218, 178, 225, 24, 2, 31, 137, 180, 241, 242, 230, 215, 145, 103, 76, 119, 163, 195, 156, 99, 70, 145, 240])),
    (LandingService::HeliusSender, "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT", Address::from_bytes([34, 96, 162, 3, 10, 223, 156, 227, 124, 181, 224, 66, 188, 210, 206, 49, 116, 200, 220, 182, 230, 81, 151, 112, 199, 51, 36, 154, 97, 89, 151, 242])),
    (LandingService::HeliusSender, "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey", Address::from_bytes([58, 85, 239, 180, 56, 167, 176, 188, 184, 59, 203, 62, 80, 207, 32, 141, 33, 111, 124, 93, 13, 68, 144, 31, 96, 212, 143, 189, 140, 93, 13, 26])),
    (LandingService::HeliusSender, "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or", Address::from_bytes([51, 86, 139, 17, 49, 181, 107, 142, 120, 81, 174, 201, 204, 208, 184, 172, 125, 191, 127, 159, 177, 172, 89, 112, 127, 16, 117, 131, 168, 14, 108, 13])),
    // Nozomi, by Temporal: <https://use.temporal.xyz/nozomi/tipping-and-faq.md>
    (LandingService::Nozomi, "TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq", Address::from_bytes([6, 184, 50, 154, 103, 130, 159, 32, 7, 74, 241, 222, 142, 163, 199, 122, 185, 205, 154, 137, 238, 54, 133, 255, 246, 0, 229, 255, 105, 51, 74, 214])),
    (LandingService::Nozomi, "noz3jAjPiHuBPqiSPkkugaJDkJscPuRhYnSpbi8UvC4", Address::from_bytes([11, 188, 66, 202, 79, 137, 160, 104, 213, 94, 71, 54, 236, 99, 42, 90, 252, 70, 174, 169, 157, 235, 241, 240, 63, 194, 182, 229, 67, 145, 24, 61])),
    (LandingService::Nozomi, "noz3str9KXfpKknefHji8L1mPgimezaiUyCHYMDv1GE", Address::from_bytes([11, 188, 66, 205, 159, 243, 65, 170, 167, 159, 187, 53, 37, 27, 17, 153, 56, 242, 80, 245, 133, 28, 157, 155, 50, 43, 253, 99, 145, 92, 163, 187])),
    (LandingService::Nozomi, "noz6uoYCDijhu1V7cutCpwxNiSovEwLdRHPwmgCGDNo", Address::from_bytes([11, 188, 67, 16, 110, 234, 87, 225, 3, 193, 90, 249, 254, 31, 150, 171, 142, 2, 92, 21, 25, 37, 198, 185, 76, 73, 0, 135, 175, 94, 150, 8])),
    (LandingService::Nozomi, "noz9EPNcT7WH6Sou3sr3GGjHQYVkN3DNirpbvDkv9YJ", Address::from_bytes([11, 188, 67, 67, 139, 252, 73, 236, 144, 17, 89, 37, 214, 116, 229, 126, 68, 194, 126, 60, 172, 248, 79, 214, 33, 43, 108, 17, 175, 97, 148, 239])),
    (LandingService::Nozomi, "nozc5yT15LazbLTFVZzoNZCwjh3yUtW86LoUyqsBu4L", Address::from_bytes([11, 188, 69, 147, 26, 200, 24, 172, 75, 228, 139, 165, 227, 186, 69, 179, 119, 160, 113, 83, 56, 83, 26, 247, 163, 219, 165, 145, 39, 43, 94, 65])),
    (LandingService::Nozomi, "nozFrhfnNGoyqwVuwPAW4aaGqempx4PU6g6D9CJMv7Z", Address::from_bytes([11, 188, 67, 213, 129, 162, 140, 13, 113, 214, 167, 163, 119, 187, 147, 114, 226, 73, 234, 150, 37, 149, 228, 179, 94, 39, 8, 82, 83, 28, 232, 0])),
    (LandingService::Nozomi, "nozievPk7HyK1Rqy1MPJwVQ7qQg2QoJGyP71oeDwbsu", Address::from_bytes([11, 188, 70, 35, 200, 245, 89, 251, 103, 98, 223, 148, 33, 236, 31, 170, 209, 35, 218, 54, 226, 22, 167, 246, 65, 71, 184, 42, 241, 31, 213, 32])),
    (LandingService::Nozomi, "noznbgwYnBLDHu8wcQVCEw6kDrXkPdKkydGJGNXGvL7", Address::from_bytes([11, 188, 70, 122, 171, 71, 154, 103, 14, 22, 159, 133, 99, 92, 152, 101, 164, 169, 206, 111, 168, 14, 106, 130, 254, 230, 187, 59, 254, 57, 114, 96])),
    (LandingService::Nozomi, "nozNVWs5N8mgzuD3qigrCG2UoKxZttxzZ85pvAQVrbP", Address::from_bytes([11, 188, 68, 103, 167, 186, 78, 236, 108, 115, 17, 20, 47, 172, 109, 67, 85, 38, 161, 175, 16, 203, 131, 52, 42, 189, 224, 57, 191, 142, 225, 222])),
    (LandingService::Nozomi, "nozpEGbwx4BcGp6pvEdAh1JoC2CQGZdU6HbNP1v2p6P", Address::from_bytes([11, 188, 70, 158, 150, 255, 249, 3, 83, 134, 87, 89, 226, 83, 179, 158, 86, 149, 25, 42, 132, 198, 185, 57, 186, 243, 202, 237, 50, 33, 109, 76])),
    (LandingService::Nozomi, "nozrhjhkCr3zXT3BiT4WCodYCUFeQvcdUkM7MqhKqge", Address::from_bytes([11, 188, 70, 213, 19, 209, 159, 212, 200, 131, 68, 208, 250, 228, 39, 143, 24, 163, 56, 110, 145, 54, 225, 166, 249, 206, 226, 204, 180, 234, 185, 11])),
    (LandingService::Nozomi, "nozrwQtWhEdrA6W8dkbt9gnUaMs52PdAv5byipnadq3", Address::from_bytes([11, 188, 70, 218, 69, 115, 123, 21, 118, 59, 45, 232, 65, 162, 204, 77, 61, 105, 165, 155, 5, 136, 139, 221, 207, 154, 77, 223, 170, 223, 185, 138])),
    (LandingService::Nozomi, "nozUacTVWub3cL4mJmGCYjKZTnE9RbdY5AP46iQgbPJ", Address::from_bytes([11, 188, 68, 237, 194, 15, 204, 165, 161, 77, 205, 146, 103, 209, 29, 126, 235, 94, 74, 198, 92, 166, 168, 89, 207, 101, 150, 117, 62, 102, 201, 189])),
    (LandingService::Nozomi, "nozWCyTPppJjRuw2fpzDhhWbW355fzosWSzrrMYB1Qk", Address::from_bytes([11, 188, 69, 17, 152, 141, 172, 248, 80, 153, 81, 87, 70, 86, 57, 197, 234, 240, 136, 53, 118, 209, 10, 59, 128, 94, 31, 73, 46, 167, 12, 33])),
    (LandingService::Nozomi, "nozWNju6dY353eMkMqURqwQEoM3SFgEKC6psLCSfUne", Address::from_bytes([11, 188, 69, 21, 78, 23, 202, 21, 90, 254, 171, 59, 105, 40, 69, 156, 116, 122, 198, 43, 170, 85, 193, 50, 30, 19, 233, 119, 159, 94, 228, 67])),
    (LandingService::Nozomi, "nozxNBgWohjR75vdspfxR5H9ceC7XXH99xpxhVGt3Bb", Address::from_bytes([11, 188, 71, 81, 209, 169, 152, 234, 164, 26, 46, 215, 14, 118, 239, 109, 2, 192, 94, 177, 144, 60, 108, 186, 252, 203, 73, 149, 187, 211, 244, 150])),
    // bloXroute's Trader API: <https://docs.bloxroute.com/solana/trader-api/introduction/tip-and-tipping-addresses>
    (LandingService::BloXroute, "3UQUKjhMKaY2S6bjcQD6yHB7utcZt5bfarRCmctpRtUd", Address::from_bytes([36, 188, 152, 51, 201, 215, 229, 204, 71, 97, 71, 107, 254, 106, 247, 160, 84, 235, 73, 160, 204, 117, 152, 197, 210, 117, 71, 171, 251, 219, 28, 190])),
    (LandingService::BloXroute, "FogxVNs6Mm2w9rnGL1vkARSwJxvLE8mujTv3LK8RnUhF", Address::from_bytes([219, 249, 131, 109, 33, 42, 211, 149, 143, 48, 214, 226, 168, 212, 57, 152, 87, 176, 19, 244, 121, 2, 96, 107, 128, 121, 181, 133, 213, 191, 41, 210])),
    (LandingService::BloXroute, "bLx7MvxGaKdKL7mEbpk9tC79z6MnBSJoJkuaEAPu6Nd", Address::from_bytes([8, 204, 78, 35, 208, 121, 11, 68, 38, 207, 85, 203, 237, 163, 154, 142, 154, 182, 209, 149, 133, 151, 232, 84, 102, 61, 112, 168, 139, 166, 186, 122])),
    (LandingService::BloXroute, "bLx7XBqSg3LUPVf1bRgCnkJmgVZR8QEgDJBPqcRLHvp", Address::from_bytes([8, 204, 78, 39, 84, 117, 123, 84, 125, 152, 189, 8, 105, 124, 93, 98, 188, 231, 171, 3, 141, 234, 12, 53, 66, 116, 28, 166, 81, 153, 236, 201])),
    (LandingService::BloXroute, "bLx8KeZxinPwy6kkUgyzMLeqb2ARNsWjADG1dhSsVba", Address::from_bytes([8, 204, 78, 56, 249, 177, 4, 209, 152, 254, 122, 12, 67, 140, 170, 204, 99, 53, 111, 205, 34, 73, 223, 181, 85, 122, 176, 95, 203, 143, 199, 37])),
    (LandingService::BloXroute, "bLxADBknoNj8WAGw2W6GBYeq848Xx6ajhaymV1YvrHm", Address::from_bytes([8, 204, 78, 98, 147, 168, 234, 55, 180, 72, 198, 227, 5, 210, 121, 44, 91, 17, 234, 20, 169, 55, 216, 186, 117, 79, 206, 108, 68, 64, 213, 232])),
    (LandingService::BloXroute, "bLxAc88vRBwvcUQJEgcxNfBLvHPikY4csNsUmPeWea2", Address::from_bytes([8, 204, 78, 107, 73, 205, 203, 249, 152, 188, 247, 197, 155, 9, 208, 128, 91, 102, 96, 155, 137, 242, 198, 75, 110, 19, 205, 102, 131, 207, 53, 199])),
    (LandingService::BloXroute, "bLxQ88oCiTsL8Xj4YWekKi1hjrgmbE3J3FFZ2xZHR3h", Address::from_bytes([8, 204, 79, 149, 12, 126, 72, 26, 233, 48, 170, 105, 239, 170, 242, 159, 165, 162, 194, 223, 109, 154, 112, 83, 228, 198, 154, 137, 7, 185, 166, 28])),
    (LandingService::BloXroute, "bLxS7NoLuynNRJ4mCnEE2YbtwJFttYsEyp2ME7rp2yt", Address::from_bytes([8, 204, 79, 192, 209, 3, 173, 139, 127, 173, 217, 33, 49, 138, 167, 70, 97, 82, 25, 181, 43, 64, 120, 115, 101, 109, 108, 149, 61, 201, 91, 111])),
    (LandingService::BloXroute, "bLxW6mCov7VEbrKc3S9tcBRcfSzRnLCbNp3Dfn3SJG5", Address::from_bytes([8, 204, 80, 24, 177, 229, 40, 160, 106, 33, 222, 12, 224, 33, 33, 43, 220, 127, 203, 102, 7, 22, 234, 155, 238, 116, 241, 213, 115, 114, 255, 118])),
    (LandingService::BloXroute, "bLxXSGXs4mYPTC5okZXed1qzvjNwNJ48QJ82hT2V7w7", Address::from_bytes([8, 204, 80, 54, 33, 128, 19, 184, 163, 186, 108, 253, 240, 123, 22, 17, 49, 221, 244, 134, 246, 188, 43, 208, 169, 224, 96, 101, 120, 238, 224, 74])),
    (LandingService::BloXroute, "bLxYi3vojbbB7hVzVDVTdBLVPhp7GJ3ZB3BwdK5sFXi", Address::from_bytes([8, 204, 80, 82, 39, 34, 5, 190, 211, 100, 96, 133, 174, 98, 68, 84, 121, 119, 122, 216, 237, 88, 120, 119, 20, 226, 18, 142, 199, 189, 146, 61])),
    (LandingService::BloXroute, "bLxhLPgBXtUpX4b1bH3HatuMGMSKT9GnwtuCGiMSAqe", Address::from_bytes([8, 204, 81, 16, 45, 125, 183, 21, 17, 206, 224, 14, 172, 168, 131, 78, 84, 89, 205, 139, 181, 206, 182, 113, 54, 252, 218, 27, 113, 42, 174, 81])),
    (LandingService::BloXroute, "bLxpY1mniuFW4PgkNA4JiNxoeKHFszryi6tNgyZAiAA", Address::from_bytes([8, 204, 81, 174, 201, 116, 111, 177, 133, 225, 50, 85, 85, 213, 120, 35, 173, 146, 216, 182, 133, 42, 194, 112, 214, 197, 184, 222, 167, 64, 190, 127])),
    (LandingService::BloXroute, "bLxuETxd2tgWxBALNwPzAfHhsik4BzD3nrEBCiPNZQD", Address::from_bytes([8, 204, 82, 22, 66, 246, 112, 11, 99, 92, 140, 168, 191, 42, 225, 142, 171, 85, 230, 186, 144, 198, 66, 92, 234, 232, 223, 7, 78, 216, 253, 202])),
    (LandingService::BloXroute, "bLxuL2gK5FW7xfahvwLrxLyW76vcCpNsKQY2CmnE6kV", Address::from_bytes([8, 204, 82, 24, 95, 241, 61, 58, 89, 48, 174, 65, 50, 138, 98, 172, 133, 6, 147, 83, 36, 150, 205, 207, 79, 125, 230, 12, 1, 206, 175, 38])),
    (LandingService::BloXroute, "bLxv4Hnub7nDJWHs8s17o9bGU65Bnx6Yqp2fqtMgHmm", Address::from_bytes([8, 204, 82, 40, 108, 202, 134, 106, 129, 84, 177, 240, 122, 84, 132, 119, 54, 160, 74, 235, 110, 17, 186, 53, 110, 76, 181, 238, 39, 177, 54, 156])),
    // bloXroute, former accounts no longer on its page: <https://docs.bags.fm/principles/tipping>
    (LandingService::BloXroute, "HWEoBxYs7ssKuudEjzjmpfJVX7Dvi7wescFsVx2L5yoY", Address::from_bytes([245, 56, 111, 18, 189, 151, 85, 159, 134, 228, 110, 186, 19, 120, 123, 40, 248, 211, 194, 66, 104, 230, 185, 241, 3, 102, 126, 31, 160, 85, 40, 155])),
    (LandingService::BloXroute, "95cfoy472fcQHaw4tPGBTKpn6ZQnfEPfBgDQx6gcRmRg", Address::from_bytes([120, 12, 38, 93, 148, 39, 100, 196, 184, 162, 109, 133, 106, 227, 156, 147, 118, 233, 165, 236, 99, 210, 66, 159, 31, 141, 228, 226, 142, 233, 11, 215])),
    // 0slot: <https://0slot.trade/docs.php>
    (LandingService::ZeroSlot, "6fQaVhYZA4w3MBSXjJ81Vf6W1EDYeUPXpgVQ6UQyU1Av", Address::from_bytes([84, 33, 42, 31, 27, 158, 214, 7, 129, 107, 55, 215, 137, 227, 198, 75, 64, 69, 54, 6, 83, 208, 66, 136, 48, 252, 24, 45, 37, 45, 113, 151])),
    (LandingService::ZeroSlot, "4HiwLEP2Bzqj3hM2ENxJuzhcPCdsafwiet3oGkMkuQY4", Address::from_bytes([48, 219, 197, 146, 14, 105, 55, 171, 154, 70, 56, 18, 62, 44, 95, 125, 211, 196, 155, 152, 63, 156, 197, 101, 11, 73, 73, 151, 155, 103, 87, 213])),
    (LandingService::ZeroSlot, "7toBU3inhmrARGngC7z6SjyP85HgGMmCTEwGNRAcYnEK", Address::from_bytes([102, 106, 245, 143, 224, 92, 57, 235, 92, 97, 227, 183, 134, 192, 56, 54, 167, 75, 104, 200, 244, 117, 17, 225, 81, 113, 218, 14, 222, 189, 250, 128])),
    (LandingService::ZeroSlot, "8mR3wB1nh4D6J9RUCugxUpc6ya8w38LPxZ3ZjcBhgzws", Address::from_bytes([115, 98, 142, 228, 33, 153, 48, 176, 95, 197, 130, 13, 32, 243, 34, 171, 37, 178, 103, 38, 49, 144, 186, 9, 158, 180, 88, 87, 70, 235, 152, 10])),
    (LandingService::ZeroSlot, "6SiVU5WEwqfFapRuYCndomztEwDjvS5xgtEof3PLEGm9", Address::from_bytes([80, 224, 222, 96, 206, 138, 25, 81, 79, 120, 114, 189, 205, 40, 226, 218, 96, 25, 147, 152, 9, 251, 217, 2, 110, 240, 63, 93, 230, 110, 38, 148])),
    (LandingService::ZeroSlot, "TpdxgNJBWZRL8UXF5mrEsyWxDWx9HQexA9P1eTWQ42p", Address::from_bytes([6, 222, 246, 242, 99, 209, 133, 124, 74, 104, 127, 10, 6, 214, 230, 7, 69, 243, 166, 34, 198, 16, 150, 24, 138, 73, 238, 199, 155, 198, 231, 189])),
    (LandingService::ZeroSlot, "D8f3WkQu6dCF33cZxuAsrKHrGsqGP2yvAHf8mX6RXnwf", Address::from_bytes([180, 66, 83, 18, 203, 127, 180, 173, 113, 145, 241, 224, 140, 135, 60, 17, 45, 63, 132, 94, 76, 22, 231, 69, 214, 7, 50, 71, 204, 234, 118, 134])),
    (LandingService::ZeroSlot, "GQPFicsy3P3NXxB5piJohoxACqTvWE9fKpLgdsMduoHE", Address::from_bytes([228, 220, 211, 44, 174, 246, 19, 88, 208, 48, 197, 132, 28, 4, 198, 61, 172, 147, 255, 20, 75, 229, 51, 223, 239, 227, 194, 60, 48, 204, 202, 133])),
    (LandingService::ZeroSlot, "Ey2JEr8hDkgN8qKJGrLf2yFjRhW7rab99HVxwi5rcvJE", Address::from_bytes([207, 129, 236, 16, 44, 109, 242, 227, 178, 231, 157, 41, 5, 248, 40, 57, 84, 64, 17, 88, 16, 87, 194, 31, 221, 114, 204, 171, 146, 126, 236, 163])),
    (LandingService::ZeroSlot, "4iUgjMT8q2hNZnLuhpqZ1QtiV8deFPy2ajvvjEpKKgsS", Address::from_bytes([55, 51, 45, 111, 162, 143, 234, 110, 238, 202, 137, 59, 160, 197, 200, 125, 108, 1, 178, 143, 169, 121, 231, 172, 171, 116, 239, 6, 241, 255, 199, 121])),
    (LandingService::ZeroSlot, "3Rz8uD83QsU8wKvZbgWAPvCNDU6Fy8TSZTMcPm3RB6zt", Address::from_bytes([36, 29, 234, 217, 251, 36, 232, 51, 178, 155, 227, 132, 219, 60, 90, 165, 207, 184, 145, 106, 90, 199, 123, 192, 79, 109, 47, 91, 17, 101, 182, 33])),
    (LandingService::ZeroSlot, "DiTmWENJsHQdawVUUKnUXkconcpW4Jv52TnMWhkncF6t", Address::from_bytes([188, 235, 82, 122, 134, 122, 86, 173, 205, 163, 97, 213, 175, 120, 62, 98, 139, 80, 254, 141, 253, 39, 242, 144, 98, 93, 154, 251, 77, 181, 154, 245])),
    (LandingService::ZeroSlot, "HRyRhQ86t3H4aAtgvHVpUJmw64BDrb61gRiKcdKUXs5c", Address::from_bytes([244, 32, 187, 41, 51, 32, 191, 188, 0, 75, 59, 228, 127, 83, 190, 36, 31, 40, 46, 181, 62, 16, 151, 89, 235, 57, 22, 210, 238, 21, 13, 51])),
    (LandingService::ZeroSlot, "7y4whZmw388w1ggjToDLSBLv47drw5SUXcLk6jtmwixd", Address::from_bytes([103, 131, 26, 247, 74, 131, 252, 51, 63, 183, 33, 35, 238, 77, 167, 66, 203, 92, 196, 88, 194, 230, 63, 126, 253, 223, 76, 158, 168, 14, 121, 110])),
    (LandingService::ZeroSlot, "J9BMEWFbCBEjtQ1fG5Lo9kouX1HfrKQxeUxetwXrifBw", Address::from_bytes([254, 175, 6, 147, 217, 77, 141, 232, 248, 250, 160, 217, 242, 192, 189, 206, 127, 186, 193, 121, 135, 243, 58, 246, 98, 42, 253, 226, 221, 28, 215, 10])),
    (LandingService::ZeroSlot, "8U1JPQh3mVQ4F5jwRdFTBzvNRQaYFQppHQYoH38DJGSQ", Address::from_bytes([110, 236, 212, 75, 85, 197, 87, 235, 206, 95, 142, 30, 128, 253, 227, 51, 192, 185, 151, 52, 16, 82, 208, 129, 168, 202, 1, 7, 9, 114, 240, 37])),
    (LandingService::ZeroSlot, "Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3", Address::from_bytes([201, 223, 44, 211, 196, 171, 17, 42, 8, 226, 43, 238, 134, 116, 149, 9, 188, 145, 251, 226, 138, 101, 48, 244, 28, 73, 89, 71, 200, 78, 238, 42])),
    (LandingService::ZeroSlot, "FCjUJZ1qozm1e8romw216qyfQMaaWKxWsuySnumVCCNe", Address::from_bytes([211, 5, 7, 22, 38, 89, 66, 132, 138, 58, 193, 39, 209, 28, 61, 4, 232, 234, 59, 123, 42, 138, 231, 206, 87, 235, 162, 3, 127, 240, 240, 235])),
    (LandingService::ZeroSlot, "ENxTEjSQ1YabmUpXAdCgevnHQ9MHdLv8tzFiuiYJqa13", Address::from_bytes([198, 199, 211, 196, 76, 112, 219, 215, 136, 43, 24, 86, 41, 35, 44, 165, 98, 209, 41, 218, 173, 88, 221, 242, 62, 13, 137, 55, 196, 73, 152, 214])),
    (LandingService::ZeroSlot, "6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK", Address::from_bytes([86, 251, 82, 81, 134, 188, 172, 239, 39, 226, 193, 55, 92, 65, 100, 198, 122, 97, 66, 85, 11, 181, 149, 13, 77, 85, 94, 12, 183, 107, 137, 196])),
    (LandingService::ZeroSlot, "Cix2bHfqPcKcM233mzxbLk14kSggUUiz2A87fJtGivXr", Address::from_bytes([174, 47, 150, 205, 238, 30, 152, 46, 98, 127, 213, 229, 191, 95, 147, 155, 166, 129, 3, 112, 67, 127, 223, 189, 76, 156, 232, 146, 49, 65, 243, 233])),
    // NextBlock: <https://docs.nextblock.io/getting-started/quickstart>
    (LandingService::NextBlock, "NextbLoCkVtMGcV47JzewQdvBpLqT9TxQFozQkN98pE", Address::from_bytes([5, 140, 31, 97, 169, 139, 148, 66, 188, 231, 112, 168, 39, 137, 75, 107, 120, 93, 138, 204, 221, 68, 73, 236, 240, 93, 176, 21, 1, 76, 224, 95])),
    (LandingService::NextBlock, "NexTbLoCkWykbLuB1NkjXgFWkX9oAtcoagQegygXXA2", Address::from_bytes([5, 140, 29, 58, 247, 27, 119, 170, 14, 79, 35, 196, 205, 180, 99, 76, 178, 166, 245, 226, 151, 223, 187, 43, 249, 202, 95, 51, 114, 151, 30, 163])),
    (LandingService::NextBlock, "NeXTBLoCKs9F1y5PJS9CKrFNNLU1keHW71rfh7KgA1X", Address::from_bytes([5, 139, 160, 109, 108, 69, 66, 216, 239, 152, 99, 112, 26, 184, 158, 18, 248, 6, 18, 31, 66, 111, 32, 225, 85, 96, 185, 238, 37, 56, 89, 90])),
    (LandingService::NextBlock, "NexTBLockJYZ7QD7p2byrUa6df8ndV2WSd8GkbWqfbb", Address::from_bytes([5, 140, 29, 49, 217, 174, 219, 151, 60, 33, 250, 33, 36, 183, 50, 54, 132, 125, 122, 237, 44, 212, 182, 156, 17, 226, 227, 165, 236, 239, 49, 254])),
    (LandingService::NextBlock, "neXtBLock1LeC67jYd1QdAa32kbVeubsfPNTJC1V5At", Address::from_bytes([11, 177, 147, 17, 206, 20, 253, 141, 117, 209, 206, 171, 169, 116, 7, 164, 102, 59, 73, 113, 141, 146, 136, 171, 56, 145, 213, 198, 42, 204, 117, 77])),
    (LandingService::NextBlock, "nEXTBLockYgngeRmRrjDV31mGSekVPqZoMGhQEZtPVG", Address::from_bytes([11, 150, 109, 224, 29, 8, 205, 96, 14, 200, 229, 143, 114, 216, 253, 238, 153, 33, 139, 211, 145, 119, 127, 76, 156, 153, 162, 196, 192, 166, 27, 87])),
    (LandingService::NextBlock, "NEXTbLoCkB51HpLBLojQfpyVAMorm3zzKg7w9NFdqid", Address::from_bytes([5, 112, 125, 107, 139, 24, 232, 99, 139, 3, 82, 200, 45, 12, 215, 159, 137, 230, 50, 182, 119, 117, 24, 250, 192, 103, 202, 130, 163, 96, 207, 206])),
    (LandingService::NextBlock, "nextBLoCkPMgmG8ZgJtABeScP35qLa2AMCNKntAP7Xc", Address::from_bytes([11, 178, 15, 214, 59, 120, 105, 50, 175, 43, 151, 101, 76, 33, 55, 113, 180, 119, 234, 9, 231, 163, 161, 38, 76, 216, 32, 47, 126, 33, 106, 231])),
    // Astralane Iris: <https://astralane.gitbook.io/docs/low-latency/endpoints-and-configs>
    (LandingService::Astralane, "astrazznxsGUhWShqgNtAdfrzP2G83DzcWVJDxwV9bF", Address::from_bytes([8, 173, 182, 121, 35, 196, 219, 218, 200, 89, 20, 202, 204, 158, 90, 62, 201, 3, 56, 40, 101, 126, 123, 30, 53, 118, 55, 222, 138, 138, 243, 130])),
    (LandingService::Astralane, "astra4uejePWneqNaJKuFFA8oonqCE1sqF6b45kDMZm", Address::from_bytes([8, 173, 182, 120, 201, 25, 97, 9, 105, 215, 198, 116, 135, 172, 112, 205, 185, 151, 159, 77, 189, 43, 202, 134, 62, 66, 208, 184, 199, 15, 9, 12])),
    (LandingService::Astralane, "astra9xWY93QyfG6yM8zwsKsRodscjQ2uU2HKNL5prk", Address::from_bytes([8, 173, 182, 120, 209, 144, 55, 236, 115, 210, 14, 251, 148, 208, 156, 160, 18, 205, 232, 177, 96, 53, 157, 25, 74, 8, 33, 187, 186, 34, 91, 81])),
    (LandingService::Astralane, "astraRVUuTHjpwEVvNBeQEgwYx9w9CFyfxjYoobCZhL", Address::from_bytes([8, 173, 182, 120, 235, 154, 113, 59, 120, 64, 14, 45, 41, 178, 137, 76, 243, 27, 139, 132, 90, 8, 236, 93, 224, 97, 34, 85, 190, 196, 9, 59])),
    (LandingService::Astralane, "astraEJ2fEj8Xmy6KLG7B3VfbKfsHXhHrNdCQx7iGJK", Address::from_bytes([8, 173, 182, 120, 216, 213, 49, 3, 163, 122, 174, 168, 19, 93, 200, 45, 6, 146, 245, 158, 70, 184, 117, 248, 100, 184, 143, 193, 219, 219, 250, 112])),
    (LandingService::Astralane, "astraubkDw81n4LuutzSQ8uzHCv4BhPVhfvTcYv8SKC", Address::from_bytes([8, 173, 182, 121, 26, 184, 165, 61, 241, 95, 51, 148, 124, 225, 244, 113, 42, 196, 21, 206, 187, 228, 95, 196, 91, 80, 26, 8, 149, 138, 211, 43])),
    (LandingService::Astralane, "astraZW5GLFefxNPAatceHhYjfA1ciq9gvfEg2S47xk", Address::from_bytes([8, 173, 182, 120, 249, 7, 237, 85, 245, 176, 106, 200, 0, 22, 112, 241, 97, 149, 10, 200, 210, 122, 68, 70, 219, 163, 74, 154, 235, 39, 166, 97])),
    (LandingService::Astralane, "astrawVNP4xDBKT7rAdxrLYiTSTdqtUr63fSMduivXK", Address::from_bytes([8, 173, 182, 121, 29, 227, 189, 172, 134, 131, 251, 234, 216, 202, 92, 240, 204, 22, 103, 80, 21, 228, 19, 170, 87, 242, 165, 144, 143, 176, 106, 250])),
    (LandingService::Astralane, "AstrA1ejL4UeXC2SBP4cpeEmtcFPZVLxx3XGKXyCW6to", Address::from_bytes([146, 194, 216, 209, 236, 204, 223, 196, 125, 237, 20, 156, 82, 222, 113, 103, 86, 193, 211, 244, 110, 95, 154, 173, 80, 21, 248, 71, 30, 249, 50, 40])),
    (LandingService::Astralane, "AsTra79FET4aCKWspPqeSFvjJNyp96SvAnrmyAxqg5b7", Address::from_bytes([146, 166, 150, 99, 228, 208, 231, 244, 107, 28, 17, 104, 84, 150, 178, 191, 88, 244, 110, 165, 220, 222, 200, 202, 87, 181, 104, 13, 125, 178, 103, 2])),
    (LandingService::Astralane, "AstrABAu8CBTyuPXpV4eSCJ5fePEPnxN8NqBaPKQ9fHR", Address::from_bytes([146, 194, 216, 213, 138, 105, 91, 92, 17, 198, 79, 3, 107, 108, 114, 205, 14, 248, 242, 124, 148, 87, 249, 32, 34, 201, 221, 156, 40, 143, 4, 0])),
    (LandingService::Astralane, "AsTRADtvb6tTmrsqULQ9Wji9PigDMjhfEMza6zkynEvV", Address::from_bytes([146, 166, 23, 145, 92, 177, 140, 122, 76, 76, 81, 101, 156, 45, 121, 100, 253, 135, 232, 108, 210, 67, 94, 85, 212, 113, 24, 148, 11, 96, 9, 26])),
    (LandingService::Astralane, "AsTRAEoyMofR3vUPpf9k68Gsfb6ymTZttEtsAbv8Bk4d", Address::from_bytes([146, 166, 23, 145, 181, 158, 88, 217, 54, 235, 189, 90, 79, 111, 251, 129, 44, 202, 77, 241, 1, 201, 108, 150, 168, 74, 156, 41, 132, 132, 159, 254])),
    (LandingService::Astralane, "AStrAJv2RN2hKCHxwUMtqmSxgdcNZbihCwc1mCSnG83W", Address::from_bytes([140, 91, 83, 170, 228, 159, 36, 6, 39, 194, 165, 168, 161, 175, 246, 44, 188, 241, 189, 53, 219, 43, 93, 1, 233, 142, 16, 37, 30, 229, 62, 21])),
    (LandingService::Astralane, "Astran35aiQUF57XZsmkWMtNCtXGLzs8upfiqXxth2bz", Address::from_bytes([146, 194, 218, 243, 115, 136, 14, 22, 50, 123, 182, 153, 54, 199, 212, 54, 8, 220, 58, 140, 69, 136, 17, 128, 144, 59, 61, 222, 181, 89, 47, 97])),
    (LandingService::Astralane, "AStRAnpi6kFrKypragExgeRoJ1QnKH7pbSjLAKQVWUum", Address::from_bytes([140, 90, 214, 241, 16, 167, 8, 6, 217, 137, 251, 141, 156, 40, 124, 202, 149, 32, 154, 176, 184, 39, 66, 233, 6, 173, 86, 113, 142, 139, 46, 104])),
    (LandingService::Astralane, "ASTRaoF93eYt73TYvwtsv6fMWHWbGmMUZfVZPo3CRU9C", Address::from_bytes([140, 62, 148, 129, 27, 175, 232, 48, 75, 215, 223, 154, 137, 152, 112, 73, 110, 98, 45, 252, 6, 25, 124, 79, 36, 119, 183, 145, 130, 120, 185, 215])),
    // BlockRazor: <https://docs.blockrazor.io/transaction-submission/transaction-sending/solana/priority-fee-and-tip.md>
    (LandingService::BlockRazor, "FjmZZrFvhnqqb9ThCuMVnENaM3JGVuGWNyCAxRJcFpg9", Address::from_bytes([218, 248, 101, 147, 203, 122, 87, 229, 227, 84, 205, 173, 127, 151, 183, 51, 2, 13, 152, 38, 181, 211, 13, 147, 24, 162, 27, 113, 76, 182, 207, 250])),
    (LandingService::BlockRazor, "6No2i3aawzHsjtThw81iq1EXPJN6rh8eSJCLaYZfKDTG", Address::from_bytes([79, 223, 173, 98, 37, 194, 111, 186, 62, 187, 237, 135, 174, 224, 188, 178, 194, 195, 44, 44, 210, 96, 69, 96, 137, 115, 93, 64, 112, 51, 104, 19])),
    (LandingService::BlockRazor, "A9cWowVAiHe9pJfKAj3TJiN9VpbzMUq6E4kEvf5mUT22", Address::from_bytes([135, 237, 252, 12, 114, 242, 174, 43, 138, 202, 75, 110, 224, 23, 96, 33, 50, 186, 181, 21, 158, 208, 250, 92, 143, 189, 83, 9, 35, 200, 246, 91])),
    (LandingService::BlockRazor, "Gywj98ophM7GmkDdaWs4isqZnDdFCW7B46TXmKfvyqSm", Address::from_bytes([237, 117, 181, 110, 134, 16, 111, 89, 131, 202, 140, 82, 246, 24, 57, 93, 233, 144, 220, 97, 156, 244, 181, 229, 139, 93, 9, 3, 21, 5, 11, 230])),
    (LandingService::BlockRazor, "68Pwb4jS7eZATjDfhmTXgRJjCiZmw1L7Huy4HNpnxJ3o", Address::from_bytes([76, 47, 112, 160, 115, 174, 10, 190, 69, 158, 141, 191, 162, 196, 91, 139, 255, 71, 176, 246, 27, 115, 108, 16, 254, 136, 48, 74, 193, 184, 81, 14])),
    (LandingService::BlockRazor, "4ABhJh5rZPjv63RBJBuyWzBK3g9gWMUQdTZP2kiW31V9", Address::from_bytes([46, 237, 97, 126, 164, 203, 58, 69, 72, 204, 127, 61, 97, 56, 121, 179, 252, 175, 93, 20, 247, 5, 38, 80, 6, 128, 146, 57, 145, 86, 113, 96])),
    (LandingService::BlockRazor, "B2M4NG5eyZp5SBQrSdtemzk5TqVuaWGQnowGaCBt8GyM", Address::from_bytes([148, 237, 33, 56, 243, 101, 152, 237, 21, 90, 53, 5, 243, 132, 130, 92, 89, 194, 95, 23, 64, 113, 176, 17, 93, 5, 64, 9, 211, 143, 21, 168])),
    (LandingService::BlockRazor, "5jA59cXMKQqZAVdtopv8q3yyw9SYfiE3vUCbt7p8MfVf", Address::from_bytes([70, 59, 102, 29, 224, 84, 82, 23, 164, 182, 171, 190, 99, 131, 91, 9, 62, 186, 231, 109, 115, 218, 227, 206, 217, 145, 72, 141, 177, 23, 169, 198])),
    (LandingService::BlockRazor, "5YktoWygr1Bp9wiS1xtMtUki1PeYuuzuCF98tqwYxf61", Address::from_bytes([67, 145, 98, 6, 205, 138, 85, 43, 228, 12, 207, 33, 124, 29, 145, 85, 228, 109, 66, 55, 114, 217, 224, 220, 123, 212, 208, 192, 83, 180, 226, 66])),
    (LandingService::BlockRazor, "295Avbam4qGShBYK7E9H5Ldew4B3WyJGmgmXfiWdeeyV", Address::from_bytes([16, 237, 12, 183, 247, 11, 107, 30, 233, 21, 240, 137, 252, 157, 132, 217, 78, 58, 13, 101, 83, 244, 134, 56, 23, 134, 68, 89, 53, 53, 181, 104])),
    (LandingService::BlockRazor, "EDi4rSy2LZgKJX74mbLTFk4mxoTgT6F7HxxzG2HBAFyK", Address::from_bytes([196, 105, 85, 109, 164, 38, 53, 57, 180, 86, 147, 104, 190, 62, 58, 150, 117, 230, 138, 201, 66, 248, 2, 145, 156, 9, 69, 230, 41, 208, 251, 130])),
    (LandingService::BlockRazor, "BnGKHAC386n4Qmv9xtpBVbRaUTKixjBe3oagkPFKtoy6", Address::from_bytes([160, 45, 82, 147, 161, 35, 249, 239, 169, 183, 36, 169, 153, 87, 38, 182, 186, 170, 132, 208, 254, 72, 29, 102, 1, 76, 35, 176, 200, 37, 223, 5])),
    (LandingService::BlockRazor, "Dd7K2Fp7AtoN8xCghKDRmyqr5U169t48Tw5fEd3wT9mq", Address::from_bytes([187, 140, 73, 172, 231, 3, 246, 102, 212, 242, 144, 178, 133, 203, 195, 197, 160, 65, 154, 134, 180, 100, 86, 244, 191, 243, 130, 34, 3, 73, 87, 120])),
    (LandingService::BlockRazor, "AP6qExwrbRgBAVaehg4b5xHENX815sMabtBzUzVB4v8S", Address::from_bytes([139, 98, 141, 217, 182, 243, 26, 92, 148, 32, 83, 77, 85, 29, 17, 77, 61, 87, 133, 90, 2, 182, 188, 89, 222, 68, 204, 43, 130, 218, 113, 123])),
    // Falcon, by Corvus Labs: <https://docs.corvus-labs.io/falcon/tips>
    (LandingService::Falcon, "Fa1con11xLjPddfzRwRUB16sbFZggp2JeJkCeWREyR8X", Address::from_bytes([216, 120, 123, 81, 118, 227, 32, 83, 167, 217, 81, 159, 23, 107, 13, 120, 89, 45, 252, 37, 5, 34, 112, 207, 152, 188, 143, 169, 114, 36, 197, 100])),
    (LandingService::Falcon, "Fa1con11TM1RuAQzbQzYjTy4Ekfap9Lnc9fnEbQYEd6Q", Address::from_bytes([216, 120, 123, 81, 118, 223, 109, 107, 132, 74, 100, 3, 166, 98, 149, 0, 77, 120, 170, 239, 172, 6, 26, 132, 54, 60, 26, 185, 29, 162, 66, 161])),
    (LandingService::Falcon, "Fa1con113Bvi76nS5AzUiRDC2fqjfzkNMUNRLgQybMYt", Address::from_bytes([216, 120, 123, 81, 118, 220, 88, 135, 225, 107, 120, 166, 210, 157, 203, 237, 109, 106, 73, 196, 246, 172, 97, 24, 60, 74, 231, 5, 173, 136, 101, 121])),
    (LandingService::Falcon, "Fa1con1QGHJK232s8yZpzZZwqPexnAKcoyKj626LNsMv", Address::from_bytes([216, 120, 123, 81, 119, 136, 48, 249, 216, 131, 190, 19, 142, 130, 21, 15, 114, 170, 80, 133, 48, 46, 246, 74, 56, 210, 240, 182, 208, 73, 184, 29])),
    (LandingService::Falcon, "Fa1con1zUzb6qJVFz5tNkPq1Ahm8H1qKW7Q48252QbkQ", Address::from_bytes([216, 120, 123, 81, 120, 133, 96, 92, 180, 21, 58, 235, 237, 58, 255, 115, 131, 13, 238, 21, 156, 140, 85, 95, 98, 42, 39, 75, 4, 254, 238, 133])),
    (LandingService::Falcon, "Fa1con16d3MSwd3SAiwvr2LwgkpE7ot8zntbpuec8HAx", Address::from_bytes([216, 120, 123, 81, 119, 5, 168, 173, 115, 156, 90, 34, 17, 154, 154, 189, 193, 179, 20, 14, 63, 36, 12, 74, 213, 212, 49, 90, 26, 210, 99, 105])),
    (LandingService::Falcon, "Fa1con1i7mpa7Qc6epYJ6r4P9AbU77DFFz173r59Df1x", Address::from_bytes([216, 120, 123, 81, 120, 12, 73, 94, 139, 208, 46, 25, 2, 74, 18, 23, 95, 222, 18, 183, 110, 146, 30, 171, 38, 171, 254, 201, 14, 99, 237, 175])),
    (LandingService::Falcon, "Fa1con18nWn8TdAGL7JX8PertfMUGVSc899NawokJ4Bq", Address::from_bytes([216, 120, 123, 81, 119, 21, 170, 73, 31, 162, 42, 200, 247, 151, 56, 28, 16, 12, 42, 11, 24, 127, 201, 237, 5, 161, 131, 202, 8, 247, 19, 248])),
    (LandingService::Falcon, "Fa1con1GKusK2EqsfzrDzGPaYZSxQtFGzJiRMMU9Zm2g", Address::from_bytes([216, 120, 123, 81, 119, 77, 118, 137, 212, 76, 28, 243, 164, 36, 186, 96, 105, 254, 29, 142, 53, 208, 120, 143, 98, 200, 211, 103, 78, 200, 68, 241])),
    (LandingService::Falcon, "Fa1con1RDwVwM9VrJ53CwVefD3VU9c58EMpDawV7fLMi", Address::from_bytes([216, 120, 123, 81, 119, 143, 74, 163, 85, 98, 219, 25, 40, 28, 99, 118, 222, 43, 162, 229, 164, 92, 122, 51, 2, 177, 46, 215, 211, 159, 146, 45])),
    // Jupiter's transaction sender (Beam): <https://developers.jup.ag/docs/transaction/submit>
    (LandingService::JupiterBeam, "GGztQqQ6pCPaJQnNpXBgELr5cs3WwDakRbh1iEMzjgSJ", Address::from_bytes([226, 248, 119, 232, 61, 174, 198, 136, 143, 67, 171, 181, 174, 123, 49, 27, 183, 140, 52, 150, 8, 151, 252, 229, 167, 184, 44, 22, 226, 15, 241, 151])),
    (LandingService::JupiterBeam, "2MFoS3MPtvyQ4Wh4M9pdfPjz6UhVoNbFbGJAskCPCj3h", Address::from_bytes([20, 12, 9, 195, 136, 108, 28, 106, 132, 79, 50, 147, 27, 207, 4, 170, 195, 23, 133, 25, 177, 192, 254, 83, 212, 255, 42, 113, 14, 180, 222, 60])),
    (LandingService::JupiterBeam, "BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV", Address::from_bytes([154, 128, 11, 255, 76, 135, 54, 136, 150, 194, 15, 193, 64, 115, 235, 241, 203, 90, 163, 117, 254, 129, 254, 77, 189, 200, 43, 164, 223, 183, 94, 120])),
    (LandingService::JupiterBeam, "6U91aKa8pmMxkJwBCfPTmUEfZi6dHe7DcFq2ALvB2tbB", Address::from_bytes([81, 62, 44, 93, 186, 66, 195, 189, 131, 48, 218, 189, 131, 78, 233, 151, 229, 80, 53, 137, 250, 0, 85, 245, 224, 144, 228, 231, 46, 204, 3, 18])),
    (LandingService::JupiterBeam, "4xDsmeTWPNjgSVSS1VTfzFq3iHZhp77ffPkAmkZkdu71", Address::from_bytes([58, 184, 144, 63, 183, 53, 202, 177, 198, 124, 89, 175, 72, 87, 237, 246, 27, 10, 248, 50, 165, 10, 124, 89, 227, 33, 145, 158, 14, 200, 169, 188])),
    (LandingService::JupiterBeam, "CapuXNQoDviLvU1PxFiizLgPNQCxrsag1uMeyk6zLVps", Address::from_bytes([172, 26, 227, 208, 135, 242, 146, 55, 6, 37, 72, 247, 12, 76, 4, 174, 194, 169, 149, 105, 73, 134, 231, 203, 180, 103, 82, 6, 33, 211, 134, 48])),
    (LandingService::JupiterBeam, "9nnLbotNTcUhvbrsA6Mdkx45Sm82G35zo28AqUvjExn8", Address::from_bytes([130, 151, 229, 68, 255, 68, 64, 106, 19, 183, 250, 100, 194, 207, 250, 62, 198, 225, 93, 248, 147, 94, 0, 199, 65, 112, 222, 174, 240, 19, 243, 125])),
    (LandingService::JupiterBeam, "6LXutJvKUw8Q5ue2gCgKHQdAN4suWW8awzFVC6XCguFx", Address::from_bytes([79, 75, 108, 14, 65, 8, 253, 42, 106, 36, 120, 234, 224, 172, 197, 157, 178, 27, 180, 237, 245, 17, 193, 98, 207, 96, 45, 30, 12, 9, 1, 251])),
    (LandingService::JupiterBeam, "HFqp6ErWHY6Uzhj8rFyjYuDya2mXUpYEk8VW75K9PSiY", Address::from_bytes([241, 136, 80, 94, 135, 164, 139, 217, 217, 158, 193, 28, 230, 24, 168, 204, 244, 181, 182, 186, 225, 50, 92, 179, 41, 233, 197, 67, 54, 142, 208, 29])),
    (LandingService::JupiterBeam, "DSN3j1ykL3obAVNv7ZX49VsFCPe4LqzxHnmtLiPwY6xg", Address::from_bytes([184, 203, 143, 172, 217, 200, 198, 118, 79, 54, 223, 54, 182, 117, 210, 126, 101, 252, 224, 106, 219, 250, 69, 32, 218, 228, 87, 14, 6, 127, 109, 9])),
    (LandingService::JupiterBeam, "69yhtoJR4JYPPABZcSNkzuqbaFbwHsCkja1sP1Q2aVT5", Address::from_bytes([76, 151, 50, 157, 68, 40, 152, 75, 177, 225, 76, 106, 158, 245, 93, 169, 222, 77, 122, 137, 10, 24, 110, 117, 186, 53, 222, 189, 46, 153, 16, 112])),
    (LandingService::JupiterBeam, "HU23r7UoZbqTUuh3vA7emAGztFtqwTeVips789vqxxBw", Address::from_bytes([244, 166, 219, 222, 188, 47, 58, 101, 248, 154, 224, 251, 51, 45, 254, 106, 154, 230, 137, 205, 219, 135, 62, 11, 126, 58, 107, 180, 92, 188, 122, 110])),
    (LandingService::JupiterBeam, "3LoAYHuSd7Gh8d7RTFnhvYtiTiefdZ5ByamU42vkzd76", Address::from_bytes([34, 201, 155, 137, 56, 253, 103, 11, 114, 27, 40, 98, 185, 234, 221, 167, 102, 85, 28, 223, 110, 40, 187, 179, 175, 4, 108, 169, 180, 118, 213, 233])),
    (LandingService::JupiterBeam, "3CgvbiM3op4vjrrjH2zcrQUwsqh5veNVRjFCB9N6sRoD", Address::from_bytes([32, 181, 231, 179, 248, 254, 61, 137, 54, 163, 124, 224, 22, 96, 19, 10, 0, 167, 195, 168, 153, 117, 39, 133, 135, 250, 111, 97, 203, 176, 163, 24])),
    (LandingService::JupiterBeam, "GP8StUXNYSZjPikyRsvkTbvRV1GBxMErb59cpeCJnDf1", Address::from_bytes([228, 138, 128, 84, 205, 76, 154, 107, 233, 81, 197, 243, 243, 48, 146, 205, 38, 118, 152, 83, 235, 146, 238, 58, 149, 118, 28, 68, 252, 59, 163, 4])),
    (LandingService::JupiterBeam, "7iWnBRRhBCiNXXPhqiGzvvBkKrvFSWqqmxRyu9VyYBxE", Address::from_bytes([99, 200, 155, 28, 193, 23, 219, 20, 32, 64, 160, 18, 92, 249, 187, 253, 233, 58, 107, 141, 124, 138, 176, 38, 66, 139, 111, 46, 194, 50, 235, 195])),
    // Solana Vibe Station's Lightspeed: <https://docs.solanavibestation.com/api-reference/lightspeed>
    (LandingService::Lightspeed, "svsMoWJBwLcs8JgfN8VaF111tAc199KpYeTKRwxRtip", Address::from_bytes([13, 11, 243, 17, 50, 173, 250, 15, 180, 126, 104, 106, 42, 108, 142, 107, 236, 168, 216, 135, 116, 186, 158, 229, 63, 78, 207, 199, 9, 210, 124, 149])),
];

/// The tip accounts by address, built once.
static SERVICE_OF_ACCOUNT: LazyLock<HashMap<Address, LandingService>> = LazyLock::new(|| {
    TIP_ACCOUNTS
        .iter()
        .map(|&(service, _, account)| (account, service))
        .collect()
});

/// The landing service whose tip account `account` is, if it is one.
pub fn landing_service(account: Address) -> Option<LandingService> {
    SERVICE_OF_ACCOUNT.get(&account).copied()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn writes_each_tip_account_the_same_in_bytes_and_in_base58() {
        for (_, written, account) in TIP_ACCOUNTS {
            assert_eq!(account.to_string(), written);
        }
    }

    #[test]
    fn recognises_every_listed_tip_account_and_nothing_else() {
        for (service, written, account) in TIP_ACCOUNTS {
            assert_eq!(landing_service(account), Some(service), "{written}");
        }
        assert_eq!(landing_service(Address::from_bytes([7; 32])), None);
    }

    #[test]
    fn lists_each_account_once() {
        let accounts: BTreeSet<_> = TIP_ACCOUNTS
            .iter()
            .map(|&(_, _, account)| account)
            .collect();
        assert_eq!(accounts.len(), TIP_ACCOUNTS.len());
    }
}
