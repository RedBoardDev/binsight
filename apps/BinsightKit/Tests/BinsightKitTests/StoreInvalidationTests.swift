import Observation
import XCTest

@testable import BinsightKit

private func totals(pnl: Double = 1) -> PortfolioTotals {
    PortfolioTotals(
        uPnlSol: pnl, uPnlPct: 2, feesSol: 0.1, claimedFeesSol: 0.05, unclaimedFeesSol: 0.05,
        tvlSol: 10, idleSol: 7.5, walletTotalSol: 17.5, openCount: 1, inRangeCount: 1,
        outOfRangeCount: 0)
}

/// The socket delivers a full snapshot every second, for weeks. Under `@Observable` every write
/// invalidates its observers — so a write that changes nothing still costs a render. These tests pin
/// the "no change, no write" rule that keeps a resting app resting.
@MainActor
final class StoreInvalidationTests: XCTestCase {
    /// Runs `mutate` and reports whether it invalidated anything the menu bar reads.
    /// The flag is boxed because `onChange` is `@Sendable`: Swift 6 rightly refuses a captured `var`.
    private func invalidates(_ store: PortfolioStore, _ mutate: () -> Void) -> Bool {
        let fired = Flag()
        withObservationTracking {
            _ = store.totals
            _ = store.positions
            _ = store.connection
            _ = store.health
        } onChange: {
            fired.raise()
        }
        mutate()
        return fired.isRaised
    }

    func testAnIdenticalStateFrameDoesNotInvalidateObservers() {
        let store = PortfolioStore()
        let frame = WalletState(scope: "all", totals: totals(), openPositions: [])
        store.apply(frame)
        XCTAssertFalse(invalidates(store) { store.apply(frame) })
    }

    func testAChangedStateFrameStillInvalidatesObservers() {
        // The guard must not go so far as to freeze the UI on real movement.
        let store = PortfolioStore()
        store.apply(WalletState(scope: "all", totals: totals(pnl: 1), openPositions: []))
        XCTAssertTrue(
            invalidates(store) {
                store.apply(WalletState(scope: "all", totals: totals(pnl: 2), openPositions: []))
            })
    }

    func testReassertingTheLiveConnectionDoesNotInvalidateObservers() {
        // The receive loop calls this on every frame, not just on transitions.
        let store = PortfolioStore()
        store.setConnection(.live)
        XCTAssertFalse(invalidates(store) { store.setConnection(.live) })
    }

    func testARealConnectionTransitionStillInvalidatesObservers() {
        let store = PortfolioStore()
        store.setConnection(.live)
        XCTAssertTrue(invalidates(store) { store.setConnection(.offline) })
    }

    func testAnUnchangedHealthPayloadDoesNotInvalidateObservers() {
        let store = PortfolioStore()
        let health = Health(
            ok: true, wsConnected: true, meteoraOk: true, chainTipSlot: 42, sources: nil)
        store.setHealth(health)
        XCTAssertFalse(invalidates(store) { store.setHealth(health) })
    }

    func testADegradedHealthPayloadStillInvalidatesObservers() {
        let store = PortfolioStore()
        store.setHealth(
            Health(ok: true, wsConnected: true, meteoraOk: true, chainTipSlot: 42, sources: nil))
        XCTAssertTrue(
            invalidates(store) {
                store.setHealth(
                    Health(
                        ok: false, wsConnected: false, meteoraOk: true, chainTipSlot: 43,
                        sources: nil))
            })
    }
}
