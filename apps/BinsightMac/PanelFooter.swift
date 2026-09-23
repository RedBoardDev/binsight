import AppKit
import SwiftUI

/// The panel's foot: Settings and Quit, as menu-style rows.
struct PanelFooter: View {
    var body: some View {
        VStack(spacing: 2) {
            SettingsLink { menuLabel("gearshape", "Settings") }
                .buttonStyle(HoverRowStyle())
            Button { NSApplication.shared.terminate(nil) } label: {
                menuLabel("power", "Quit")
            }
            .buttonStyle(HoverRowStyle())
        }
        .padding(6)
    }

    /// Footer rows carry their own padding so the hover highlight has room to breathe; `6` on the
    /// footer plus `8` here lands the icon on `inset`, in line with every section label above.
    private func menuLabel(_ icon: String, _ label: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).frame(width: 18).foregroundStyle(.secondary)
            Text(label).font(.system(size: 13))
            Spacer()
        }
        .contentShape(Rectangle())
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }
}
