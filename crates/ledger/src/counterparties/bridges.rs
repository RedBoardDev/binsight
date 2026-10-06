//! The programs of the cross-chain bridges.
//!
//! What leaves the wallet through a bridge is not spent: it moves to the owner's account on
//! another chain, so the ledger books it as a capital withdrawal, and what arrives through a
//! bridge as a capital deposit. A transaction whose top-level instructions call one of these
//! programs is a bridge transaction. This table copies the program addresses each bridge
//! publishes (read on 2026-10-06), with the page each group comes from. A bridge that is only a
//! plain transfer to a deposit address needs no entry: a plain transfer is already capital.

use std::collections::HashMap;
use std::sync::LazyLock;

use binsight_solana::Address;
use binsight_solana::transaction::TransactionView;

/// A cross-chain bridge whose transfers are capital, not PnL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BridgeId {
    /// Mayan.
    Mayan,
    /// Relay.
    Relay,
    /// deBridge DLN.
    DeBridge,
    /// Wormhole Token Bridge (Portal).
    Wormhole,
    /// Allbridge.
    Allbridge,
    /// Gas.zip.
    GasZip,
    /// Circle CCTP.
    Cctp,
    /// Across.
    Across,
}

/// Every known bridge program: its bridge, its address as the bridge's documentation writes it,
/// and the same address as bytes. A test checks that both forms agree.
#[rustfmt::skip]
const BRIDGE_PROGRAMS: [(BridgeId, &str, Address); 19] = [
    // Mayan: <https://docs.mayan.finance/resources/chains-contracts>
    (BridgeId::Mayan, "mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny", Address::from_bytes([11, 107, 248, 205, 116, 108, 231, 96, 249, 80, 85, 44, 85, 152, 98, 174, 216, 114, 199, 114, 162, 20, 72, 123, 246, 185, 192, 30, 125, 141, 104, 70])), // Swift v2
    (BridgeId::Mayan, "BLZRi6frs4X4DNLw56V4EXai1b6QVESN1BhHBTYM9VcY", Address::from_bytes([153, 151, 145, 159, 167, 138, 236, 76, 132, 1, 171, 152, 160, 90, 6, 143, 120, 184, 203, 246, 74, 95, 151, 135, 120, 190, 84, 227, 180, 155, 144, 93])), // Swift
    (BridgeId::Mayan, "dkpZqrxHFrhziEMQ931GLtfy11nFkCsfMftH9u6QwBU", Address::from_bytes([9, 106, 116, 233, 3, 25, 194, 4, 181, 184, 143, 211, 39, 248, 48, 46, 150, 232, 85, 99, 135, 4, 129, 18, 125, 61, 168, 117, 86, 166, 16, 95])), // MCTP
    (BridgeId::Mayan, "Gx9rivpS3YR8pBFwMuP6omYqVxunpLvLkNn7ubNyuZZ5", Address::from_bytes([237, 0, 67, 107, 237, 145, 26, 17, 61, 134, 198, 18, 244, 177, 159, 86, 96, 247, 144, 177, 56, 108, 73, 93, 177, 194, 110, 189, 46, 24, 104, 4])), // Fast MCTP
    (BridgeId::Mayan, "FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf", Address::from_bytes([210, 217, 33, 51, 213, 173, 251, 74, 147, 216, 216, 196, 239, 37, 121, 228, 205, 111, 167, 194, 169, 149, 45, 224, 212, 2, 161, 246, 187, 235, 202, 102])), // Wormhole swap
    // Relay: <https://github.com/relayprotocol/relay-depository>
    (BridgeId::Relay, "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2", Address::from_bytes([121, 38, 137, 55, 142, 205, 81, 216, 4, 6, 235, 12, 170, 59, 98, 121, 91, 235, 16, 182, 197, 220, 150, 188, 46, 13, 240, 60, 191, 238, 26, 191])), // Depository
    (BridgeId::Relay, "DPArtTLbEqa6EuXHfL5UFLBZhFjiEXWRudhvXDrjwXUr", Address::from_bytes([183, 250, 43, 119, 135, 69, 177, 52, 204, 226, 217, 202, 70, 173, 67, 149, 126, 229, 232, 134, 72, 244, 213, 136, 124, 63, 108, 0, 214, 176, 248, 55])), // Forwarder
    // deBridge DLN: <https://docs.debridge.com/dln-details/overview/deployed-contracts>
    (BridgeId::DeBridge, "src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4", Address::from_bytes([13, 7, 32, 254, 68, 141, 229, 157, 136, 17, 226, 77, 109, 249, 23, 220, 141, 13, 152, 179, 146, 221, 244, 221, 43, 98, 42, 116, 122, 96, 253, 237])), // DlnSource, orders out
    (BridgeId::DeBridge, "dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo", Address::from_bytes([9, 114, 112, 164, 97, 127, 207, 220, 85, 215, 251, 186, 218, 148, 25, 54, 48, 179, 27, 77, 76, 119, 210, 249, 202, 194, 194, 237, 179, 193, 224, 208])), // DlnDestination, fills in
    // Wormhole Token Bridge (Portal): <https://wormhole.com/docs/products/reference/contract-addresses/>
    (BridgeId::Wormhole, "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb", Address::from_bytes([14, 10, 88, 158, 100, 136, 20, 122, 148, 220, 250, 89, 43, 144, 253, 212, 17, 82, 187, 44, 167, 123, 246, 1, 103, 88, 166, 244, 223, 157, 33, 180])), // Token Bridge
    // Allbridge: <https://docs-core.allbridge.io/product/how-does-allbridge-core-work/allbridge-core-contracts>
    // and, for Classic, <https://docs.allbridge.io/allbridge-overview/bridge-contracts>
    (BridgeId::Allbridge, "CctpV8uRiXws7KZxpUXfPWy9BhCiWaeBRzsJgELvQKvu", Address::from_bytes([172, 162, 121, 226, 59, 169, 79, 244, 71, 238, 210, 60, 60, 87, 170, 123, 83, 115, 133, 154, 120, 11, 116, 123, 145, 88, 226, 32, 69, 220, 117, 70])), // Core, CCTP interface
    (BridgeId::Allbridge, "BrdgN2RPzEMWF96ZbnnJaUtQDQx7VRXYaHHbYCBvceWB", Address::from_bytes([161, 75, 205, 54, 2, 234, 247, 206, 178, 148, 117, 240, 9, 64, 125, 218, 16, 65, 44, 220, 133, 181, 200, 42, 207, 83, 87, 57, 139, 237, 113, 24])), // Core, former bridge
    (BridgeId::Allbridge, "BBbD1WSjbHKfyE3TSFWF6vx1JV51c8msKSQy4ess6pXp", Address::from_bytes([151, 75, 90, 250, 150, 21, 73, 233, 79, 30, 152, 68, 243, 206, 6, 155, 155, 25, 142, 220, 188, 253, 66, 40, 22, 250, 76, 46, 165, 95, 2, 127])), // Classic
    // Gas.zip: <https://dev.gas.zip/gas/code-examples/svm-deposit/solana-forwarder>
    (BridgeId::GasZip, "FzuVV5WeLyWHDuX6SPbeLgqkvePDTzMCRKYAhDbiP3z3", Address::from_bytes([222, 217, 19, 49, 26, 249, 61, 89, 207, 92, 222, 241, 28, 38, 212, 39, 34, 179, 60, 149, 67, 145, 157, 73, 240, 200, 246, 33, 131, 162, 19, 116])), // deposit program
    // Circle CCTP: <https://developers.circle.com/cctp/v1/solana-programs>
    (BridgeId::Cctp, "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3", Address::from_bytes([166, 95, 201, 67, 65, 154, 90, 213, 144, 4, 47, 214, 124, 151, 145, 253, 1, 90, 207, 83, 165, 76, 200, 35, 237, 184, 255, 129, 185, 237, 114, 46])), // v1 TokenMessengerMinter
    (BridgeId::Cctp, "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd", Address::from_bytes([166, 95, 201, 137, 219, 95, 93, 66, 117, 159, 58, 84, 96, 88, 239, 205, 205, 192, 191, 60, 24, 152, 7, 45, 142, 180, 93, 209, 216, 5, 8, 206])), // v1 MessageTransmitter
    (BridgeId::Cctp, "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", Address::from_bytes([166, 95, 200, 29, 15, 239, 168, 134, 12, 179, 184, 63, 8, 155, 2, 36, 190, 138, 102, 135, 183, 174, 73, 245, 148, 192, 185, 180, 215, 233, 56, 147])), // v2 TokenMessengerMinter
    (BridgeId::Cctp, "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC", Address::from_bytes([166, 95, 200, 28, 225, 158, 220, 210, 210, 195, 64, 176, 47, 166, 27, 225, 213, 186, 221, 225, 89, 40, 51, 221, 249, 32, 9, 216, 207, 104, 84, 85])), // v2 MessageTransmitter
    // Across: <https://docs.across.to/chains-and-contracts>
    (BridgeId::Across, "DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru", Address::from_bytes([183, 102, 64, 134, 222, 55, 238, 112, 130, 28, 16, 68, 91, 22, 47, 44, 126, 200, 121, 91, 208, 128, 12, 20, 98, 148, 158, 35, 40, 209, 221, 90])), // SpokePool
];

/// The bridge programs by address, built once.
static BRIDGE_OF_PROGRAM: LazyLock<HashMap<Address, BridgeId>> = LazyLock::new(|| {
    BRIDGE_PROGRAMS
        .iter()
        .map(|&(bridge, _, program)| (program, bridge))
        .collect()
});

/// The bridge whose program `program` is, if it is one.
pub fn bridge_of(program: Address) -> Option<BridgeId> {
    BRIDGE_OF_PROGRAM.get(&program).copied()
}

/// The bridge a top-level instruction of `tx` calls, if any.
pub fn bridge_called_by(tx: &TransactionView) -> Option<BridgeId> {
    tx.instructions
        .iter()
        .filter(|node| node.position.inner.is_none())
        .find_map(|node| bridge_of(node.program))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn writes_each_bridge_program_the_same_in_bytes_and_in_base58() {
        for (_, written, program) in BRIDGE_PROGRAMS {
            assert_eq!(program.to_string(), written);
        }
    }

    #[test]
    fn recognises_every_listed_bridge_program_and_nothing_else() {
        for (bridge, written, program) in BRIDGE_PROGRAMS {
            assert_eq!(bridge_of(program), Some(bridge), "{written}");
        }
        assert_eq!(bridge_of(Address::from_bytes([7; 32])), None);
    }

    #[test]
    fn lists_each_program_once() {
        let programs: BTreeSet<_> = BRIDGE_PROGRAMS
            .iter()
            .map(|&(_, _, program)| program)
            .collect();
        assert_eq!(programs.len(), BRIDGE_PROGRAMS.len());
    }
}
