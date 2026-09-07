import Observation
import XCTest

@testable import BinsightKit

private func totals(
    pnl: Double = 1.23456, pct: Double = 5, open: Int = 2, fees: Double = 0.1, tvl: Double = 10,
) -> PortfolioTotals {
    PortfolioTotals(
        uPnlSol: pnl, uPnlPct: pct, feesSol: fees, claimedFeesSol: 0, unclaimedFeesSol: fees,
        tvlSol: tvl, idleSol: 1, walletTotalSol: 20, openCount: open, inRangeCount: open,
        outOfRangeCount: 0)
}

final class MenuBarSnapshotTests: XCTestCase {
    func testShowsPnLToThreeDecimalsAndTheOpenCount() {
        let snapshot = menuBarSnapshot(connection: .live, totals: totals())
        XCTAssertEqual(snapshot.text, "+1.235 · 2")
    }

    func testConnectedWithNothingOpenFallsBackToTheGlyph() {
        let snapshot = menuBarSnapshot(connection: .live, totals: totals(open: 0))
        XCTAssertNil(snapshot.text)
        XCTAssertTrue(snapshot.isIdle)
    }

    func testAnUnconfiguredAppAsksToBeSetUp() {
        XCTAssertEqual(menuBarSnapshot(connection: .unconfigured, totals: nil).text, "Setup")
    }

    func testToneIsNeutralOnADustMove() {
        // A move under 0.1% must not flash the label green or red.
        XCTAssertEqual(menuBarSnapshot(connection: .live, totals: totals(pct: 0.05)).tone, .neutral)
        XCTAssertEqual(menuBarSnapshot(connection: .live, totals: totals(pct: 5)).tone, .profit)
        XCTAssertEqual(menuBarSnapshot(connection: .live, totals: totals(pct: -5)).tone, .loss)
    }

    func testAMoveBelowTheDisplayedPrecisionYieldsAnIdenticalSnapshot() {
        // The quantisation that keeps a resting app resting: sub-milli-SOL jitter is invisible in a
        // "%.3f" label, so it must not produce a different snapshot.
        let a = menuBarSnapshot(connection: .live, totals: totals(pnl: 1.234561))
        let b = menuBarSnapshot(connection: .live, totals: totals(pnl: 1.234599))
        XCTAssertEqual(a, b)
    }
}

/// The point of the snapshot: numbers the menu bar does NOT display must not invalidate it.
@MainActor
final class MenuBarInvalidationTests: XCTestCase {
    private func menuBarInvalidates(_ store: PortfolioStore, _ mutate: () -> Void) -> Bool {
        let fired = Flag()
        withObservationTracking { _ = store.menuBar } onChange: { fired.raise() }
        mutate()
        return fired.isRaised
    }

    private let t0 = Date(timeIntervalSince1970: 2_000_000)

    func testFeesAndTVLMovingDoesNotInvalidateTheMenuBar() {
        let store = PortfolioStore()
        store.setConnection(.live)
        store.applyForTesting(WalletState(scope: "all", totals: totals(), openPositions: []), now: t0)
        // Only invisible fields move. `totals` legitimately changes for the panel; the label must not
        // — and this holds even a full throttle window later, so it is the snapshot doing the work.
        let moved = totals(fees: 0.987, tvl: 42)
        let later = t0.addingTimeInterval(menuBarThrottleSeconds * 2)
        XCTAssertFalse(
            menuBarInvalidates(store) {
                store.applyForTesting(
                    WalletState(scope: "all", totals: moved, openPositions: []), now: later)
            })
        XCTAssertEqual(store.totals?.tvlSol, 42) // …while the panel's data really did update
    }

    func testSubPrecisionPnLDriftDoesNotInvalidateTheMenuBar() {
        let store = PortfolioStore()
        store.setConnection(.live)
        store.applyForTesting(
            WalletState(scope: "all", totals: totals(pnl: 1.234561), openPositions: []), now: t0)
        XCTAssertFalse(
            menuBarInvalidates(store) {
                store.applyForTesting(
                    WalletState(scope: "all", totals: totals(pnl: 1.234599), openPositions: []),
                    now: t0.addingTimeInterval(menuBarThrottleSeconds * 2))
            })
    }

    func testARealPnLMoveStillInvalidatesTheMenuBarOnceTheWindowElapses() {
        let store = PortfolioStore()
        store.setConnection(.live)
        store.applyForTesting(
            WalletState(scope: "all", totals: totals(pnl: 1.2), openPositions: []), now: t0)
        XCTAssertTrue(
            menuBarInvalidates(store) {
                store.applyForTesting(
                    WalletState(scope: "all", totals: totals(pnl: 1.9), openPositions: []),
                    now: t0.addingTimeInterval(menuBarThrottleSeconds))
            })
    }
}

/// Sendable one-shot flag for the `@Sendable` observation callback.
final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var raised = false
    func raise() { lock.withLock { raised = true } }
    var isRaised: Bool { lock.withLock { raised } }
}

/// The throttle: a digit drifting waits, anything the user must see does not.
@MainActor
final class MenuBarThrottleTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func frame(pnl: Double, open: Int = 2) -> WalletState {
        WalletState(scope: "all", totals: totals(pnl: pnl, open: open), openPositions: [])
    }

    private func store() -> PortfolioStore {
        let s = PortfolioStore()
        s.setConnection(.live)
        s.applyForTesting(frame(pnl: 1.0), now: t0)
        return s
    }

    func testADigitMoveWithinTheWindowIsHeldBack() {
        let s = store()
        s.applyForTesting(frame(pnl: 2.0), now: t0.addingTimeInterval(1))
        XCTAssertEqual(s.menuBar.text, "+1.000 · 2") // label still on the throttled value
        XCTAssertEqual(s.totals?.uPnlSol, 2.0) // …the panel's own data is current
    }

    func testTheMoveLandsOnceTheWindowElapses() {
        let s = store()
        s.applyForTesting(frame(pnl: 2.0), now: t0.addingTimeInterval(1))
        s.applyForTesting(frame(pnl: 2.0), now: t0.addingTimeInterval(menuBarThrottleSeconds))
        XCTAssertEqual(s.menuBar.text, "+2.000 · 2")
    }

    func testAPositionOpeningBypassesTheThrottle() {
        // Opening or closing a position is the whole reason someone glances at the menu bar.
        let s = store()
        s.applyForTesting(frame(pnl: 1.0, open: 3), now: t0.addingTimeInterval(1))
        XCTAssertEqual(s.menuBar.text, "+1.000 · 3")
    }

    func testFlippingFromGainToLossBypassesTheThrottle() {
        let s = store()
        s.applyForTesting(
            WalletState(
                scope: "all", totals: totals(pnl: -1, pct: -9, open: 2), openPositions: []),
            now: t0.addingTimeInterval(1))
        XCTAssertEqual(s.menuBar.tone, .loss)
    }

    func testGoingOfflineIsNeverThrottledAndMarksTheReadoutStale() {
        // The figures stay (they remain the best answer available) but must stop looking live.
        let s = store()
        s.setConnection(.offline)
        XCTAssertTrue(s.menuBar.isStale)
        XCTAssertEqual(s.menuBar.text, "+1.000 · 2")
    }

    func testAnAuthFailureReplacesTheFiguresRatherThanFreezingThem() {
        let s = store()
        s.setConnection(.unauthorized)
        XCTAssertEqual(s.menuBar.text, "Auth")
    }
}
