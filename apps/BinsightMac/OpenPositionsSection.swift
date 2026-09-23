import BinsightKit
import SwiftUI

/// Open positions get their own bounded box so a long open list no longer pushes the closed history
/// far down a single shared scroll. Beyond `openScrollThreshold` cards the box switches from hugging
/// its content to a fixed, scrolling height (a pure count test — no layout measurement).
struct OpenPositionsSection: View {
    let app: AppController
    let now: Date
    @Environment(PortfolioStore.self) private var store

    private static let openScrollThreshold = 3 // above this many open cards, the box scrolls
    private static let openScrollCap: CGFloat = 320 // open box height once it scrolls (≈ threshold cards)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            openHeader // fixed: only the cards below scroll
            openScrollBox
        }
    }

    private var openHeader: some View {
        sectionLabel("OPEN POSITIONS", count: store.positions.count)
            .padding(.horizontal, PanelLayout.inset)
            .padding(.top, PanelLayout.sectionGap)
            .padding(.bottom, PanelLayout.labelGap)
    }

    /// Few open positions → the cards hug their content (no blank gap). Many → a fixed-height scroll so a
    /// long list can't push the closed history off-screen.
    @ViewBuilder private var openScrollBox: some View {
        if store.positions.count > Self.openScrollThreshold {
            ScrollView { openCards }
                .frame(height: Self.openScrollCap)
                .scrollBounceBehavior(.basedOnSize)
        } else {
            openCards
        }
    }

    private var openCards: some View {
        VStack(alignment: .leading, spacing: 6) {
            if store.positions.isEmpty {
                Text(store.wallets.isEmpty ? "Add a wallet in Settings to start" : "No open positions")
                    .font(.system(size: 12)).foregroundStyle(.secondary).padding(.vertical, 6)
            } else {
                ForEach(store.positions) { p in
                    PositionCard(p: p, now: now, bins: store.bins[p.positionAddress])
                        // Per-card, on-demand: asks once per position each time the panel opens, and
                        // the store's TTL/in-flight claim drops the ask when a snapshot is still
                        // fresh — so reopening the panel costs nothing. (`onAppear`, not `task`: the
                        // fetch is its own Task, and must not be cancelled when the panel closes.)
                        .onAppear {
                            app.rest.loadBins(for: p.positionAddress)
                        }
                }
            }
        }
        .padding(.horizontal, PanelLayout.inset).padding(.bottom, PanelLayout.sectionGap)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sectionLabel(_ title: String, count: Int) -> some View {
        HStack {
            // Same tracking as the PORTFOLIO/CLOSED labels — all-caps at 11pt needs the extra
            // letter-spacing, and having only one of the three carry it read as a mistake.
            Text(title).font(.system(size: 11, weight: .semibold)).tracking(0.6)
                .foregroundStyle(.secondary)
            Spacer()
            Text("\(count)").font(.data(11)).foregroundStyle(.secondary)
        }
    }
}
