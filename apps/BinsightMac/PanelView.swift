import BinsightKit
import SwiftUI

/// How often the open panel re-renders so relative ages stay current. Ages tick in minutes, so a 30 s
/// cadence keeps them effectively fresh while the panel is open without re-rendering on every frame.
private let ageRefreshSeconds: TimeInterval = 30

// ── Spacing scale ─────────────────────────────────────────────────────────────────────────────────
// Every section previously carried its own insets (16 for the header, 10 for the open list, 12 for the
// closed list), so PORTFOLIO sat further right than OPEN POSITIONS and the closed rows ended short of
// the cards' right edge. One scale, applied to labels, cards, rows and footer alike, is what makes the
// panel read as a single surface instead of three stacked ones.
enum PanelLayout {
    /// Distance from the panel edge to any section label, card or row.
    static let inset: CGFloat = 14
    /// Gap above a section label (below the separator that precedes it).
    static let sectionGap: CGFloat = 12
    /// Gap between a section label and its first row.
    static let labelGap: CGFloat = 6
}

/// The menu-bar panel: scope tabs, portfolio header, open + closed positions, footer. Each section
/// lives in its own file and reads the store itself.
struct PanelView: View {
    let app: AppController
    @Environment(PortfolioStore.self) private var store
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // A single wallet makes "Overview" (the all-wallets aggregate) redundant — it equals that
            // wallet — so the whole scope bar is hidden until there are at least two wallets.
            if store.wallets.count > 1 {
                PanelTabs(app: app)
                Divider()
            }
            PanelHeader(app: app)
            Divider()
            contentScroll
            Divider()
            PanelFooter()
        }
        .frame(width: 360)
        .background(panelBackground)
    }

    /// Vibrant material by default; an opaque surface under Reduce Transparency. The panel's dense
    /// numeric text otherwise sits on whatever happens to be behind the menu bar, which is exactly
    /// the legibility problem that setting exists to fix.
    @ViewBuilder private var panelBackground: some View {
        if reduceTransparency {
            Color(nsColor: .windowBackgroundColor)
        } else {
            Rectangle().fill(.regularMaterial)
        }
    }

    // Open + closed each in their own bounded scroll; labels/header/footer fixed.
    private var contentScroll: some View {
        // One timeline drives both lists so relative ages ("3m", "2h") stay fresh while the panel is open —
        // previously an age only updated when its row happened to re-render (hover).
        TimelineView(.periodic(from: .now, by: ageRefreshSeconds)) { ctx in
            VStack(alignment: .leading, spacing: 0) {
                OpenPositionsSection(app: app, now: ctx.date)
                Divider() // full width, matching the header separator — was inset by 10
                ClosedPositionsSection(app: app, now: ctx.date)
            }
        }
    }
}
