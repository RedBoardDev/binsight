import XCTest

@testable import BinsightKit

/// The skip decision is made on the RAW frame, before any decode — so what it recognises, and more
/// importantly what it refuses to recognise, is the whole safety argument.
final class PeriodicStateFrameTests: XCTestCase {
    func testAStateFrameIsRecognized() {
        XCTAssertTrue(isPeriodicStateFrame(#"{"type":"state","payload":{"scope":"all"}}"#))
    }

    func testLeadingWhitespaceIsTolerated() {
        XCTAssertTrue(isPeriodicStateFrame("  \n" + #"{"type":"state","payload":{}}"#))
    }

    func testANotifyFrameIsNeverSkippable() {
        // Dropping one of these would silently lose a user-facing alert.
        XCTAssertFalse(isPeriodicStateFrame(#"{"type":"notify","payload":{"id":"1"}}"#))
    }

    func testTheOtherRareFrameTypesAreNeverSkippable() {
        XCTAssertFalse(isPeriodicStateFrame(#"{"type":"event","payload":{}}"#))
        XCTAssertFalse(isPeriodicStateFrame(#"{"type":"closed_changed"}"#))
        XCTAssertFalse(isPeriodicStateFrame(#"{"type":"health","payload":{}}"#))
    }

    func testAnUnexpectedShapeIsNotSkippable() {
        // If the envelope ever changes, the app must fall back to decoding everything rather than
        // silently discarding frames it no longer understands.
        XCTAssertFalse(isPeriodicStateFrame(#"{"payload":{},"type":"state"}"#))
        XCTAssertFalse(isPeriodicStateFrame(#"{ "type" : "state" }"#))
        XCTAssertFalse(isPeriodicStateFrame(""))
        XCTAssertFalse(isPeriodicStateFrame("state"))
    }

    func testAFrameTypeMerelyStartingWithStateIsNotConfused() {
        XCTAssertFalse(isPeriodicStateFrame(#"{"type":"state_changed","payload":{}}"#))
    }
}
