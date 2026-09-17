import SwiftUI

/// Open-position card for the macOS panel. Pair + range badge + quick-links,
/// PnL (SOL + %), size/age, fees, and the deposited-liquidity bin chart.
public struct PositionCard: View {
    let p: OpenPosition
    /// Injected clock so the panel can keep the age fresh on a periodic tick (see `ageString`).
    let now: Date
    /// Per-bin liquidity for the chart, nil until the panel's on-demand fetch lands. Passed in rather
    /// than read from the environment so the card stays a pure view of its inputs.
    let bins: PositionBins?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    public init(p: OpenPosition, now: Date = Date(), bins: PositionBins? = nil) {
        self.p = p
        self.now = now
        self.bins = bins
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                // lineLimit(1): a long pair must truncate, never wrap to a second line (which would grow
                // the card's height). The PnL keeps priority so it's never the one compressed.
                Text("\(p.tokenX)/\(p.tokenY)")
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                RangeBadge(status: p.rangeStatus)
                if let s = p.strategy { StrategyBadge(family: s) }
                // Collapsed to zero width until hovered, so the hidden quick-links don't permanently
                // steal horizontal space from the pair (which was truncating "BONK/USDC" → "BON…").
                PositionLinks(wallet: p.wallet, positionAddress: p.positionAddress, mint: p.tokenXMint)
                    .opacity(showLinks ? 1 : 0)
                    .frame(width: showLinks ? nil : 0)
                    .allowsHitTesting(showLinks)
                    .clipped()
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 0) {
                    // Live figures: roll the changed digits rather than re-cutting the whole label.
                    Text("\(signed(p.displayPnl)) \(p.nativeQuote)")
                        .font(.data(13, weight: .semibold))
                        .foregroundStyle(pnlColor(p.displayPnlPct))
                        .contentTransition(.numericText(value: p.displayPnl))
                        .animation(dataAnimation(reduceMotion), value: p.displayPnl)
                    Text(pct2(p.displayPnlPct))
                        .font(.data(11, weight: .semibold))
                        .foregroundStyle(pnlColor(p.displayPnlPct))
                        .contentTransition(.numericText(value: p.displayPnlPct))
                        .animation(dataAnimation(reduceMotion), value: p.displayPnlPct)
                }
                .fixedSize()
                .layoutPriority(1)
            }
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    // lineLimit(1) keeps the card height fixed (no wrap to a second line).
                    Text("Size \(abs4(p.displaySize)) \(p.nativeQuote) · \(ageString(p.openedAt, now: now))")
                        .font(.data(11)).foregroundStyle(.secondary)
                        .lineLimit(1)
                    FeesLabel(position: p)
                }
                Spacer()
                // The chart sits in the old range bar's slot rather than full-width below it: a
                // full-width chart made the cards too tall to fit two positions in the panel. It
                // buckets to the width it gets, so the curve stays readable at this size.
                BinChart(data: bins, outOfRange: isOut(p.rangeStatus)).frame(width: binChartWidth)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .onHover { h in withAnimation(Theme.springPress) { hovering = h } }
        // `.contain` keeps the quick-links individually reachable while giving the card one spoken
        // summary; without it VoiceOver recites eight disconnected fragments per position.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(spokenSummary)
    }

    // Reveal the quick-links only while the row is hovered, to declutter the panel.
    private var showLinks: Bool { hovering }

    /// One sentence per position, in reading order: what it is, whether it is in range, then the
    /// numbers. "percent" is spelled out — VoiceOver reads a bare "%" inconsistently.
    private var spokenSummary: String {
        let range: String =
            switch p.rangeStatus {
            case .out_up: "out of range above"
            case .out_down: "out of range below"
            case .in: "in range"
            default: "range unknown"
            }
        let fees = p.claimedFeesSol + p.unclaimedFeesSol
        let pnl = "PnL \(signed(p.displayPnl)) \(p.nativeQuote), \(String(format: "%+.2f", p.displayPnlPct)) percent"
        let size = "size \(abs4(p.displaySize)) \(p.nativeQuote), open \(ageString(p.openedAt, now: now))"
        return "\(p.tokenX) \(p.tokenY), \(range). \(pnl). \(size). Fees \(abs4(fees)) SOL."
    }
}
