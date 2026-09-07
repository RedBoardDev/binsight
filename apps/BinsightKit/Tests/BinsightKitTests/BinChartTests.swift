import XCTest

@testable import BinsightKit

/// A position holding `count` bins of equal liquidity starting at `from`, so each test only states
/// what it actually varies.
private func flatBins(from: Int, count: Int, activeBinId: Int, amountY: Double = 1) -> PositionBins
{
    PositionBins(
        slot: 1,
        activeBinId: activeBinId,
        binStep: 10,
        bins: (from..<(from + count)).map {
            PositionBin(binId: $0, price: 1, amountX: 0, amountY: amountY)
        },
    )
}

final class BinChartTests: XCTestCase {
    func testOneBarPerBinUnderTheCap() {
        let g = binChartGeometry(flatBins(from: 100, count: 10, activeBinId: 105))
        XCTAssertEqual(g.bars.count, 10)
    }

    func testDenserRangeIsBucketedDownToTheCapWithoutDroppingBins() {
        let g = binChartGeometry(flatBins(from: 0, count: 70, activeBinId: 35), maxBars: 10)
        XCTAssertEqual(g.bars.count, 10)
        // With flat liquidity every bucket must hold some: an off-by-one in the slot maths would
        // starve the last bucket, which is exactly the bug this pins.
        XCTAssertTrue(g.bars.allSatisfy { $0.height > 0 })
    }

    func testBarHeightsAreNormalizedAgainstTheTallestBucket() {
        let bins = PositionBins(
            slot: 1, activeBinId: 0, binStep: 10,
            bins: [
                PositionBin(binId: 0, price: 1, amountX: 0, amountY: 1),
                PositionBin(binId: 1, price: 1, amountX: 0, amountY: 4),
                PositionBin(binId: 2, price: 1, amountX: 0, amountY: 2),
            ],
        )
        XCTAssertEqual(binChartGeometry(bins).bars.map(\.height), [0.25, 1, 0.5])
    }

    func testLiquidityIsMeasuredInTheQuoteTokenSoSidesAreComparable() {
        // 2 X at price 3 = 6 quote against a flat 3 quote → the X bin must be the taller bar. Reading
        // raw amounts instead would rank them the other way round.
        let bins = PositionBins(
            slot: 1, activeBinId: 0, binStep: 10,
            bins: [
                PositionBin(binId: 0, price: 3, amountX: 2, amountY: 0),
                PositionBin(binId: 1, price: 3, amountX: 0, amountY: 3),
            ],
        )
        XCTAssertEqual(binChartGeometry(bins).bars.map(\.height), [1, 0.5])
    }

    func testEmptyBucketStaysFlatWhileDustKeepsAVisibleFloor() {
        let bins = PositionBins(
            slot: 1, activeBinId: 0, binStep: 10,
            bins: [
                PositionBin(binId: 0, price: 1, amountX: 0, amountY: 1000),
                PositionBin(binId: 1, price: 1, amountX: 0, amountY: 0),
                PositionBin(binId: 2, price: 1, amountX: 0, amountY: 0.001),
            ],
        )
        let bars = binChartGeometry(bins).bars
        XCTAssertEqual(bars[1].height, 0) // no liquidity → no bar, so a gap still reads as a gap
        XCTAssertEqual(bars[2].height, binChartMinBarHeight) // dust → floored, never invisible
    }

    func testBarsBelowTheActiveBinTakeTheTokenXSide() {
        let g = binChartGeometry(flatBins(from: 100, count: 4, activeBinId: 102))
        XCTAssertEqual(g.bars.map(\.belowActive), [true, true, false, false])
    }

    func testBucketStraddlingTheActiveBinIsNotClaimedByTheXSide() {
        // 4 bins into 2 buckets ([100,101] and [102,103]) with active = 101: bucket 0 spans the
        // active bin, so colouring it as "below" would push the price marker visually right.
        let g = binChartGeometry(flatBins(from: 100, count: 4, activeBinId: 101), maxBars: 2)
        XCTAssertEqual(g.bars.map(\.belowActive), [false, false])
    }

    func testMarkerSitsAtTheShareOfTheRangeBelowTheLivePrice() {
        let g = binChartGeometry(flatBins(from: 100, count: 4, activeBinId: 102))
        XCTAssertEqual(g.activeFraction, 0.5)
    }

    func testMarkerPinsRightWhenOutOfRangeAboveTheTopBin() {
        let g = binChartGeometry(flatBins(from: 100, count: 4, activeBinId: 999))
        XCTAssertEqual(g.activeFraction, 1)
    }

    func testMarkerPinsLeftWhenOutOfRangeBelowTheBottomBin() {
        let g = binChartGeometry(flatBins(from: 100, count: 4, activeBinId: 1))
        XCTAssertEqual(g.activeFraction, 0)
    }

    func testPositionWithNoBinsYieldsNothingToDraw() {
        let g = binChartGeometry(PositionBins(slot: 1, activeBinId: 0, binStep: 10, bins: []))
        XCTAssertTrue(g.bars.isEmpty)
        XCTAssertEqual(g.activeFraction, 0)
    }

    func testFullyWithdrawnRangeDrawsFlatBarsInsteadOfNaNHeights() {
        let g = binChartGeometry(flatBins(from: 0, count: 3, activeBinId: 1, amountY: 0))
        XCTAssertEqual(g.bars.count, 3)
        XCTAssertTrue(g.bars.allSatisfy { $0.height == 0 })
    }

    func testBarCapFollowsTheAvailableWidth() {
        // The card's compact slot must still buy enough buckets to read a curve from.
        XCTAssertEqual(binChartBarCap(forWidth: binChartWidth), 28)
        XCTAssertEqual(binChartBarCap(forWidth: 40), 10)
    }

    func testBarCapIsCappedAndNeverZero() {
        XCTAssertEqual(binChartBarCap(forWidth: 5000), binChartMaxBars)
        // A view measured at zero (first layout pass) must not ask for zero buckets.
        XCTAssertEqual(binChartBarCap(forWidth: 0), 1)
        XCTAssertEqual(binChartBarCap(forWidth: 1), 1)
    }

    func testBinsPayloadDecodesFromTheWire() throws {
        let json = """
        {"slot":123,"activeBinId":8,"binStep":25,"tokenXMint":"X","tokenYMint":"Y",
        "bins":[{"binId":7,"price":0.5,"amountX":1,"amountY":2}]}
        """
        let bins = try JSONDecoder().decode(PositionBins.self, from: Data(json.utf8))
        XCTAssertEqual(bins.activeBinId, 8)
        XCTAssertEqual(bins.bins.first?.price, 0.5)
    }
}
