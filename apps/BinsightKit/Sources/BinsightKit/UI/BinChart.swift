import SwiftUI

/// Hard ceiling on the bar count, whatever the width. A DLMM position tops out at 70 bins; past this
/// the curve gains no readable detail. Bucketing SUMS liquidity, so the shape survives.
public let binChartMaxBars = 44

/// Narrowest slot a bar may occupy before the curve stops reading as a shape. The chart derives its
/// bucket count from the MEASURED width against this, so the same view works in the card's compact
/// row slot and at full width without a per-call-site magic number.
let binChartMinBarSlot: CGFloat = 4

/// Widest slot a bar may occupy. Without this a narrow range (a 5-bin position) stretched its bars
/// across the whole slot and rendered as a handful of fat blocks — unreadable AS A CURVE, and
/// visually louder than a 60-bin position. Past this the chart keeps its bar size and simply gets
/// narrower, which is the honest depiction: fewer bins IS less chart.
let binChartMaxBarSlot: CGFloat = 8

/// Shortest bar the chart draws for a bucket that holds *some* liquidity, as a share of the height.
/// An empty bucket stays at 0 — the gap between deposited and empty bins must stay visible.
let binChartMinBarHeight = 0.06

/// One drawn bar of the simplified bin chart.
public struct BinBar: Equatable, Sendable {
    /// 0…1 share of the chart height, normalized against the tallest bucket.
    public let height: Double
    /// The bucket sits entirely below the active bin (token-X side); otherwise it is at/above it
    /// (token-Y / SOL side). Drives the bar colour, mirroring the web histogram.
    public let belowActive: Bool

    public init(height: Double, belowActive: Bool) {
        self.height = height
        self.belowActive = belowActive
    }
}

/// Everything the chart view needs to draw, derived from a position's per-bin liquidity.
public struct BinChartGeometry: Equatable, Sendable {
    public let bars: [BinBar]
    /// 0…1 horizontal position of the live-price marker (0 = range low, 1 = range high).
    public let activeFraction: Double

    public init(bars: [BinBar], activeFraction: Double) {
        self.bars = bars
        self.activeFraction = activeFraction
    }
}

/// How many buckets a chart of `width` may draw: as many as fit above `binChartMinBarSlot`, capped at
/// `binChartMaxBars`, never below one. Pure so the width→detail rule is pinned by a test rather than
/// living inline in the view.
public func binChartBarCap(forWidth width: CGFloat) -> Int {
    guard width.isFinite, width > 0 else { return 1 }
    return min(binChartMaxBars, max(1, Int(width / binChartMinBarSlot)))
}

/// Width the bars actually occupy inside an `available`-wide slot: the full slot once there are
/// enough bars to fill it, otherwise only what `bars` need at `binChartMaxBarSlot` each.
public func binChartContentWidth(bars: Int, available: CGFloat) -> CGFloat {
    guard bars > 0, available.isFinite, available > 0 else { return 0 }
    return min(available, CGFloat(bars) * binChartMaxBarSlot)
}

/// Pure geometry for the card's bin chart — the whole rendering decision, kept out of the view so it
/// is unit-tested (see `BinChartTests`).
///
/// A bin's liquidity is measured in the QUOTE token (`amountY + amountX * price`) so an X-heavy and a
/// Y-heavy bin are comparable on one axis; same measure as the web's `BinHistogram`.
public func binChartGeometry(_ data: PositionBins, maxBars: Int = binChartMaxBars)
    -> BinChartGeometry
{
    let bins = data.bins
    guard !bins.isEmpty, maxBars > 0 else { return BinChartGeometry(bars: [], activeFraction: 0) }

    let barCount = min(bins.count, maxBars)
    var sums = [Double](repeating: 0, count: barCount)
    // Highest bin id landing in each bucket — a bucket counts as "below active" only when ALL of its
    // bins are, so the colour split never claims the active bin sits further right than it does.
    var upperBinId = [Int](repeating: Int.min, count: barCount)
    for (i, bin) in bins.enumerated() {
        // Even, contiguous split of the range over the bars. Integer maths keeps the last bin in the
        // last bucket (i = count-1 → barCount-1), so no bin is ever dropped.
        let slot = min(barCount - 1, i * barCount / bins.count)
        sums[slot] += bin.amountY + bin.amountX * bin.price
        upperBinId[slot] = max(upperBinId[slot], bin.binId)
    }

    let peak = sums.max() ?? 0
    let bars = (0..<barCount).map { i -> BinBar in
        let share = peak > 0 ? sums[i] / peak : 0
        return BinBar(
            height: share > 0 ? max(binChartMinBarHeight, share) : 0,
            belowActive: upperBinId[i] < data.activeBinId,
        )
    }

    // Marker = the share of the range below the live price. Out of range on the high side (no bin at
    // or above the active bin) pins it to the right edge; on the low side the first bin already
    // qualifies, which pins it left. Same derivation as the web histogram.
    let fraction =
        bins.firstIndex { $0.binId >= data.activeBinId }
            .map { Double($0) / Double(bins.count) } ?? 1
    return BinChartGeometry(bars: bars, activeFraction: fraction)
}

/// The open position's deposited-liquidity curve: one bar per bin bucket, coloured by side of the
/// live price, with a marker on the active bin. The range and where the price sits inside it are
/// both read straight off the bars.
///
/// `data` is nil until the on-demand fetch lands (or when it failed); the view then draws a flat
/// baseline so the card never changes height between states.
public struct BinChart: View {
    let data: PositionBins?
    let outOfRange: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale

    public init(data: PositionBins?, outOfRange: Bool) {
        self.data = data
        self.outOfRange = outOfRange
    }

    public var body: some View {
        GeometryReader { geo in
            let cap = binChartBarCap(forWidth: geo.size.width)
            if let geometry = data.map({ binChartGeometry($0, maxBars: cap) }), !geometry.bars.isEmpty
            {
                let content = CGSize(
                    width: binChartContentWidth(
                        bars: geometry.bars.count, available: geo.size.width),
                    height: geo.size.height,
                )
                ZStack(alignment: .bottomLeading) {
                    bars(geometry, in: content)
                    marker(at: geometry.activeFraction, in: content)
                }
                .frame(width: content.width, height: content.height)
                // Trailing, so the chart stays anchored to the card's edge instead of drifting as
                // the bin count changes.
                .frame(width: geo.size.width, alignment: .trailing)
                .animation(dataAnimation(reduceMotion), value: geometry.activeFraction)
            } else {
                placeholder
            }
        }
        .frame(height: binChartHeight)
        .accessibilityElement()
        .accessibilityLabel(accessibilityLabel)
    }

    private func bars(_ geometry: BinChartGeometry, in size: CGSize) -> some View {
        // Bar + gap widths come from the measured width so the curve always fills the slot exactly,
        // whatever the bucket count (no trailing dead space, no overflow).
        let slot = size.width / Double(geometry.bars.count)
        let width = max(1, slot - binChartBarGap)
        return HStack(alignment: .bottom, spacing: binChartBarGap) {
            ForEach(Array(geometry.bars.enumerated()), id: \.offset) { _, bar in
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(bar.belowActive ? Theme.binX : Theme.binY)
                    .frame(width: width, height: max(0, bar.height * size.height))
            }
        }
        .frame(width: size.width, height: size.height, alignment: .bottomLeading)
    }

    private func marker(at fraction: Double, in size: CGSize) -> some View {
        // A true hairline: 1 physical pixel, not 1 point. At 1pt a Retina marker renders twice as
        // heavy as the system's own separators and starts competing with the bars it annotates.
        let hairline = 1 / displayScale
        return Rectangle()
            .fill(outOfRange ? Theme.outRange : Color.primary.opacity(0.75))
            .frame(width: hairline, height: size.height)
            .offset(x: min(size.width - hairline, max(0, fraction * size.width)))
    }

    /// No data yet: a flat, dim baseline. Deliberately not a spinner — the panel must not flicker
    /// busy chrome every time it opens.
    private var placeholder: some View {
        RoundedRectangle(cornerRadius: 1, style: .continuous)
            .fill(Color.primary.opacity(0.10))
            .frame(height: 2)
            .frame(maxHeight: .infinity, alignment: .bottom)
    }

    private var accessibilityLabel: String {
        guard let data, !data.bins.isEmpty else { return "Liquidity distribution unavailable" }
        return "Liquidity across \(data.bins.count) price bins"
    }
}

/// Chart height in the card. Sized to the two-line stats block it sits beside, so swapping the old
/// range bar for the chart costs the card no extra height.
public let binChartHeight: CGFloat = 24
/// Width of the chart's slot in the card row — the old range bar's 96pt, widened just enough to keep
/// ~27 buckets above `binChartMinBarSlot`.
public let binChartWidth: CGFloat = 112
/// Gap between two bars.
private let binChartBarGap: CGFloat = 1
