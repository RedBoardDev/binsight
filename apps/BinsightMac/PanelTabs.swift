import BinsightKit
import SwiftUI

/// The scope bar: Overview + one tab per wallet.
struct PanelTabs: View {
    let app: AppController
    @Environment(PortfolioStore.self) private var store

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                tab("Overview", scope: "all")
                ForEach(store.wallets) { w in
                    tab(w.label.isEmpty ? short(w.address) : w.label, scope: w.address)
                }
            }
            .padding(.horizontal, PanelLayout.inset)
            .padding(.vertical, 8)
        }
    }

    private func tab(_ title: String, scope: String) -> some View {
        TabChip(title: title, active: store.scope == scope) {
            app.client.setScope(scope)
        }
    }
}

/// Scope tab with a hover affordance (subtle bg on the inactive tab) + pointing-hand cursor.
private struct TabChip: View {
    let title: String
    let active: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(background, in: Capsule())
                .foregroundStyle(active ? Theme.accent : .secondary)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        // The shared helper, not a bare push/pop: that pair leaked a cursor whenever the chip went
        // away under the pointer (see `PointingHandCursor`).
        .pointingHandCursor()
    }

    private var background: Color {
        if active { return Theme.accent.opacity(0.22) }
        return hovering ? Color.primary.opacity(0.07) : .clear
    }
}
