import UserNotifications
import XCTest

@testable import BinsightKit

/// The precedence rule the Settings section depends on: OS permission decides WHICH controls exist,
/// the local master switch only decides whether the rules are visible.
final class NotifSectionStateTests: XCTestCase {
    func testUnrequestedPermissionOffersOnlyTheRequest() {
        XCTAssertEqual(notifSectionState(status: .notDetermined, masterOn: false), .needsPermission)
    }

    func testUnrequestedPermissionHidesTheMasterSwitchEvenWhenLocallyEnabled() {
        // The master switch defaults to on, so this is the state a fresh install actually lands in:
        // showing an "Enable notifications" toggle there promises delivery macOS never granted.
        XCTAssertEqual(notifSectionState(status: .notDetermined, masterOn: true), .needsPermission)
    }

    func testDeniedSendsTheUserToSystemSettings() {
        // Re-asking after a denial is a no-op at the OS level, so the section must not offer it.
        XCTAssertEqual(
            notifSectionState(status: .denied, masterOn: true), .blockedInSystemSettings)
        XCTAssertEqual(
            notifSectionState(status: .denied, masterOn: false), .blockedInSystemSettings)
    }

    func testAuthorizedShowsTheRulesOnlyWhileTheMasterSwitchIsOn() {
        XCTAssertEqual(
            notifSectionState(status: .authorized, masterOn: true), .ready(rulesVisible: true))
        XCTAssertEqual(
            notifSectionState(status: .authorized, masterOn: false), .ready(rulesVisible: false))
    }

    func testProvisionalAuthorizationCountsAsAuthorized() {
        XCTAssertEqual(
            notifSectionState(status: .provisional, masterOn: true), .ready(rulesVisible: true))
    }

    // WHY: presence is reported active only when a banner will really show. Claiming it while the OS
    // withholds permission routes alerts to this Mac instead of Bark, where they vanish.
    func testOnlyFullAuthorizationCountsForPresence() {
        XCTAssertTrue(notifStatusShowsBanners(.authorized))
        XCTAssertFalse(notifStatusShowsBanners(.notDetermined))
        XCTAssertFalse(notifStatusShowsBanners(.denied))
        XCTAssertFalse(notifStatusShowsBanners(.provisional))
    }

    func testAnUnavailableOutcomeIsDistinctFromADenial() {
        // These drive different UI: a denial points at System Settings, an unavailable request means
        // the build itself can't receive notifications and retrying cannot help.
        XCTAssertNotEqual(NotifRequestOutcome.unavailable("unsigned"), .denied)
    }
}
