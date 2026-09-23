import BinsightKit
import SwiftUI

/// Closed history: a fixed header, then its own bounded scroll that pages itself in as it is read.
struct ClosedPositionsSection: View {
    let app: AppController
    let now: Date
    @Environment(PortfolioStore.self) private var store

    // Rows left below the last visible one before the next closed page is pulled — a small prefetch so
    // the list doesn't visibly stall at the bottom.
    private static let closedPrefetchRows = 3
    private static let closedScrollHeight: CGFloat = 220 // closed-history box height (always scrolls)
    /// Share of the closed box's height taken by the bottom fade — about one row, no more: enough to
    /// soften the cut without dimming a row the user is trying to read.
    private static let closedFadeFraction = 0.12

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            closedBar // fixed closed-history header
            ScrollView { closedList }
                .frame(height: Self.closedScrollHeight)
                .scrollBounceBehavior(.basedOnSize)
                .mask(closedFadeMask)
        }
    }

    /// Softens the bottom edge of the closed box, whose fixed height necessarily cuts a row in half.
    /// A hard clip mid-row looks like a rendering fault; a fade reads as "there is more below".
    private var closedFadeMask: some View {
        LinearGradient(
            stops: [
                .init(color: .black, location: 0),
                .init(color: .black, location: 1 - Self.closedFadeFraction),
                .init(color: .clear, location: 1),
            ],
            startPoint: .top,
            endPoint: .bottom,
        )
    }

    private var closedBar: some View {
        HStack(spacing: 8) {
            Text("CLOSED\(store.closedTotal > 0 ? " (\(store.closedTotal))" : "")")
                .font(.system(size: 11, weight: .semibold)).tracking(0.6)
                .foregroundStyle(.secondary)
            if let s = store.stats {
                Text(signed(s.totalPnlSol)).font(.data(11))
                    .foregroundStyle(s.totalPnlSol >= 0 ? Theme.profit : Theme.loss)
                Text("· win \(Int(s.winRate))%").font(.data(11)).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, PanelLayout.inset)
        .padding(.top, PanelLayout.sectionGap)
        .padding(.bottom, PanelLayout.labelGap)
    }

    private var closedList: some View {
        // LazyVStack, not VStack: it is what makes `onAppear` mean "scrolled into view". A plain VStack
        // lays every row out at once, so the prefetch below would chain-load the whole history on open.
        LazyVStack(spacing: 0) {
            if store.closed.isEmpty {
                Text("No closed positions yet").font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                ForEach(Array(store.closed.enumerated()), id: \.element.id) { index, c in
                    ClosedRow(c: c, now: now)
                        .onAppear { prefetchClosed(reaching: index) }
                }
                if store.hasMoreClosed {
                    loadingMoreFooter
                } else if store.closedTruncatedByCap {
                    closedCapFooter
                }
            }
        }
        .padding(.horizontal, PanelLayout.inset)
        .padding(.bottom, 8)
    }

    /// Scrolling into the last few loaded rows pulls the next page. Repeated calls are free: the store's
    /// in-flight claim and `hasMoreClosed` drop every ask that isn't the one page actually missing.
    private func prefetchClosed(reaching index: Int) {
        guard store.hasMoreClosed, index >= store.closed.count - Self.closedPrefetchRows else { return }
        app.rest.loadMoreClosed()
    }

    /// Foot of the list while more history exists — a status line, not a button: pagination is
    /// automatic, so there is nothing for the user to click.
    private var loadingMoreFooter: some View {
        Text("\(store.closed.count) of \(store.closedTotal)")
            .font(.data(11))
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .accessibilityLabel(
                "Showing \(store.closed.count) of \(store.closedTotal) closed positions")
    }

    /// Shown once pagination stops at the retention cap, so the list doesn't just fall silent as if
    /// the history had ended.
    private var closedCapFooter: some View {
        Text("First \(store.closed.count) of \(store.closedTotal) — full history on the web")
            .font(.system(size: 11))
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity)
            .multilineTextAlignment(.center)
            .padding(.vertical, 6)
    }
}

/// A closed-position row: pair on the left, stats on the right. The quick-links (LPAgent / GMGN /
/// share) stay hidden until the row is hovered — appearing beside the stats — to keep the list clean.
private struct ClosedRow: View {
    let c: ClosedPosition
    let now: Date
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            Text("\(c.tokenX)/\(c.tokenY)")
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
            Spacer()
            // Hover reveals the quick-links; at rest the same slot shows a discreet size summary.
            // Both are always laid out (ZStack) so the row never resizes between states.
            ZStack(alignment: .trailing) {
                PositionLinks(
                    wallet: c.wallet, positionAddress: c.positionAddress, mint: c.tokenXMint,
                    shareAddress: c.positionAddress)
                    .opacity(hovering ? 1 : 0)
                    .allowsHitTesting(hovering)
                restingSummary
                    .opacity(hovering ? 0 : 1)
                    .allowsHitTesting(false)
            }
            Text(signed(c.displayPnl))
                .font(.data(12, weight: .semibold))
                .foregroundStyle(pnlColor(c.displayPnlPct))
            // Fees, glyph-free (the old ⓒ read as a copyright mark). In a tabular row the dim
            // treatment and fixed column already separate this from the PnL beside it; the tooltip
            // and VoiceOver label name it for anyone who needs telling.
            Text(abs4(c.displayFees))
                .font(.data(11))
                .foregroundStyle(.secondary)
                .fixedSize()
                .help("Fees earned")
                .accessibilityLabel("fees \(abs4(c.displayFees)) \(c.nativeQuote)")
            Text(ageString(c.closedAt, now: now))
                .font(.data(11))
                .foregroundStyle(.tertiary)
                .fixedSize()
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onHover { h in withAnimation(Theme.springPress) { hovering = h } }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(spokenSummary)
    }

    /// Spoken form of the row: the same facts the columns show, in reading order.
    private var spokenSummary: String {
        let pnl = "PnL \(signed(c.displayPnl)) \(c.nativeQuote), \(String(format: "%+.2f", c.displayPnlPct)) percent"
        return "\(c.tokenX) \(c.tokenY) closed \(ageString(c.closedAt, now: now)) ago. "
            + "\(pnl). Fees \(abs4(c.displayFees)) \(c.nativeQuote). Deposited \(abs2(c.displayDeposit)) \(c.nativeQuote)."
    }

    // Size (deposited SOL, 2 dp) — shown only while the row is at rest. The DLMM shape is
    // deliberately NOT repeated here: on a closed position it no longer tells you anything
    // actionable, and it was crowding the row's one free slot.
    private var restingSummary: some View {
        Text("\(abs2(c.displayDeposit)) \(c.nativeQuote)")
            .font(.data(11))
            .foregroundStyle(.tertiary)
            .fixedSize()
    }
}
