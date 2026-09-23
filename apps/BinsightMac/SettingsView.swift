import BinsightKit
import SwiftUI

struct SettingsView: View {
    let app: AppController
    @State private var launch = LaunchAtLogin.isEnabled

    var body: some View {
        Form {
            ConnectionSettingsSection {
                app.reconnect()
            }
            Section("Behavior") {
                Toggle("Launch at login", isOn: $launch)
                    .onChange(of: launch) { _, v in LaunchAtLogin.set(v) }
            }
            Section("Wallets") {
                WalletsEditor(
                    onChange: { app.reconnect() },
                    onRemove: { app.walletRemoved($0) },
                )
            }
            NotificationsEditor()
        }
        .formStyle(.grouped)
        .frame(width: 460, height: 620)
    }
}
