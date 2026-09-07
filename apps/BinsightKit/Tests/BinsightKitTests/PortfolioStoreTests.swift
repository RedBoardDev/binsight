import XCTest

@testable import BinsightKit

private func closed(_ address: String) -> ClosedPosition {
    ClosedPosition(
        positionAddress: address, wallet: "W", tokenX: "A", tokenY: "SOL", tokenXMint: "M",
        pnlSol: 0, pnlPctSol: 0, feesSol: 0, depositSol: 1, closedAt: nil, strategy: nil)
}

private func bins(_ activeBinId: Int) -> PositionBins {
    PositionBins(
        slot: 1, activeBinId: activeBinId, binStep: 10,
        bins: [PositionBin(binId: activeBinId, price: 1, amountX: 0, amountY: 1)])
}

@MainActor
final class ClosedPagingTests: XCTestCase {
    func testAppendingAPageAdvancesTheLoadedDepth() {
        let store = PortfolioStore()
        store.replaceClosed([closed("a"), closed("b")], total: 4, pages: 1)
        store.appendClosed([closed("c"), closed("d")], total: 4, page: 2)
        XCTAssertEqual(store.closed.map(\.positionAddress), ["a", "b", "c", "d"])
        XCTAssertEqual(store.closedPage, 2)
    }

    func testAppendingDropsRowsAlreadyOnScreen() {
        // A close landing between the two fetches shifts the offset window, so page 2 repeats a row.
        // Keeping it would put a duplicate id in the list's ForEach.
        let store = PortfolioStore()
        store.replaceClosed([closed("a"), closed("b")], total: 4, pages: 1)
        store.appendClosed([closed("b"), closed("c")], total: 5, page: 2)
        XCTAssertEqual(store.closed.map(\.positionAddress), ["a", "b", "c"])
        XCTAssertEqual(store.closedTotal, 5)
    }

    func testHasMoreClosedTracksTheServerTotal() {
        let store = PortfolioStore()
        store.replaceClosed([closed("a")], total: 3, pages: 1)
        XCTAssertTrue(store.hasMoreClosed)
        store.appendClosed([closed("b"), closed("c")], total: 3, page: 2)
        XCTAssertFalse(store.hasMoreClosed)
    }

    func testAResyncKeepsTheDepthTheUserHadLoaded() {
        // The refresh triggered by a close event refetches pages 1…n in one request; the store must
        // keep reporting depth n so the NEXT "load more" asks for n+1, not page 2 again.
        let store = PortfolioStore()
        store.replaceClosed([closed("a")], total: 40, pages: 1)
        store.appendClosed([closed("b")], total: 40, page: 2)
        store.replaceClosed([closed("a"), closed("b")], total: 41, pages: 2)
        XCTAssertEqual(store.closedPage, 2)
    }

    func testAppendCannotWalkTheDepthBackwards() {
        let store = PortfolioStore()
        store.replaceClosed([closed("a")], total: 99, pages: 3)
        store.appendClosed([closed("b")], total: 99, page: 2)
        XCTAssertEqual(store.closedPage, 3)
    }

    func testPaginationStopsAtTheRetentionCap() {
        // A busy wallet has 18k+ closed rows; walking all of them into memory is the only unbounded
        // growth path in a process that runs for weeks.
        let store = PortfolioStore()
        let rows = (0..<closedRetentionCap).map { closed("p\($0)") }
        store.replaceClosed(rows, total: 18_582, pages: closedRetentionCap / closedPageSize)
        XCTAssertFalse(store.hasMoreClosed)
        XCTAssertTrue(store.closedTruncatedByCap)
    }

    func testAShortHistoryIsNotReportedAsCapped() {
        let store = PortfolioStore()
        store.replaceClosed([closed("a"), closed("b")], total: 2, pages: 1)
        XCTAssertFalse(store.hasMoreClosed)
        XCTAssertFalse(store.closedTruncatedByCap) // ran out, wasn't truncated
    }

    func testClosingThePanelReleasesTheDeepScroll() {
        let store = PortfolioStore()
        store.replaceClosed((0..<200).map { closed("p\($0)") }, total: 18_582, pages: 10)
        store.trimClosedToFirstPage()
        XCTAssertEqual(store.closed.count, closedPageSize)
        XCTAssertEqual(store.closedPage, 1) // …so the next resync fetches one page, not ten
    }

    func testTrimmingIsANoOpOnASinglePage() {
        let store = PortfolioStore()
        store.replaceClosed([closed("a")], total: 1, pages: 1)
        store.trimClosedToFirstPage()
        XCTAssertEqual(store.closed.count, 1)
    }

    func testScopeSwitchResetsTheDepth() {
        let store = PortfolioStore()
        store.replaceClosed([closed("a")], total: 40, pages: 3)
        store.resetClosedPaging()
        XCTAssertEqual(store.closedPage, 1)
    }
}

@MainActor
final class BinsCacheTests: XCTestCase {
    private let address = "pos1"

    func testAnUnknownPositionIsStale() {
        XCTAssertTrue(PortfolioStore().binsAreStale(address))
    }

    func testAFreshSnapshotIsReusedInsteadOfRefetched() {
        let store = PortfolioStore()
        let now = Date()
        store.setBins(bins(5), for: address, now: now)
        XCTAssertFalse(store.binsAreStale(address, now: now.addingTimeInterval(binsTTLSeconds - 1)))
        XCTAssertEqual(store.bins[address]?.activeBinId, 5)
    }

    func testASnapshotPastTheTTLIsRefetched() {
        let store = PortfolioStore()
        let now = Date()
        store.setBins(bins(5), for: address, now: now)
        XCTAssertTrue(store.binsAreStale(address, now: now.addingTimeInterval(binsTTLSeconds)))
    }

    func testASecondClaimIsRefusedWhileAFetchIsInFlight() {
        // Reopening the panel remounts the card and re-asks; without the in-flight half of the claim
        // that would fire a second RPC-backed read for the same position.
        let store = PortfolioStore()
        XCTAssertTrue(store.claimBinsFetch(address))
        XCTAssertFalse(store.claimBinsFetch(address))
    }

    func testAFailedFetchCanBeRetriedOnceReleased() {
        let store = PortfolioStore()
        XCTAssertTrue(store.claimBinsFetch(address))
        store.releaseBinsFetch(address) // no snapshot stored → the read failed
        XCTAssertTrue(store.claimBinsFetch(address))
    }

    func testAFreshSnapshotBlocksTheClaimWithoutAnyFetch() {
        let store = PortfolioStore()
        let now = Date()
        store.setBins(bins(5), for: address, now: now)
        XCTAssertFalse(store.claimBinsFetch(address, now: now))
    }

    func testPruningDropsSnapshotsOfPositionsThatAreNoLongerOpen() {
        let store = PortfolioStore()
        store.setBins(bins(5), for: address)
        store.setBins(bins(6), for: "pos2")
        store.positions = [
            OpenPosition(
                positionAddress: "pos2", wallet: "W", tokenX: "A", tokenY: "SOL", tokenXMint: "M",
                sizeSol: 1, pnlSol: 0, pnlPctSol: 0, claimedFeesSol: 0, unclaimedFeesSol: 0,
                rangeStatus: .in, minPrice: 1, maxPrice: 2, poolPrice: 1.5, openedAt: nil,
                strategy: nil)
        ]
        store.pruneBins()
        XCTAssertNil(store.bins[address])
        XCTAssertNotNil(store.bins["pos2"])
    }
}
