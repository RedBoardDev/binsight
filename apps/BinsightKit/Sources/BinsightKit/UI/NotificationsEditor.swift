import SwiftUI
import UserNotifications

/// Shared notification settings for both Settings screens.
///
/// OS permission comes first: until it is granted the section offers only the request (or the route
/// to System Settings once denied). A master switch alongside a permission we don't have would
/// promise delivery the OS has not agreed to — so it appears only once we're authorized, and then
/// gates the per-event rules. Renders grouped `Section`s — drop it directly inside a `Form`.
public struct NotificationsEditor: View {
    @State private var rules: [String: NotifRule] = [:]
    @State private var masterOn = Config.notificationsEnabled
    @State private var status: UNAuthorizationStatus = .notDetermined
    /// Set when the OS refused to present the prompt, so the button reports why instead of looking
    /// broken. Cleared on the next attempt.
    @State private var permissionError: String?

    public init() {}

    private var sectionState: NotifSectionState {
        notifSectionState(status: status, masterOn: masterOn)
    }

    private enum Param { case none, sol, minutes }
    private struct Kind {
        let key: String
        let name: String
        let param: Param
        init(_ key: String, _ name: String, _ param: Param = .none) {
            self.key = key
            self.name = name
            self.param = param
        }
    }

    private static let groups: [(String, [Kind])] = [
        ("Positions", [Kind("position_open", "Opened"), Kind("position_close", "Closed")]),
        ("Range", [
            Kind("oor_enter", "Out of range"),
            Kind("oor_duration", "Out of range for", .minutes),
            Kind("oor_return", "Back in range"),
        ]),
        ("Thresholds", [
            Kind("pnl_threshold", "PnL ≥", .sol),
            Kind("fees_threshold", "Fees ≥", .sol),
        ]),
    ]

    public var body: some View {
        Group {
            Section("Notifications") {
                switch sectionState {
                case .needsPermission:
                    permissionRequest
                case .blockedInSystemSettings:
                    blockedRow
                case .ready:
                    Toggle("Enable notifications", isOn: masterBinding)
                    Label("Notifications allowed", systemImage: "checkmark.circle.fill")
                        .font(.system(size: 12)).foregroundStyle(Theme.profit)
                }
            }
            if case .ready(rulesVisible: true) = sectionState {
                ForEach(Self.groups, id: \.0) { group in
                    Section(group.0) {
                        ForEach(group.1, id: \.key) { kind in row(kind) }
                    }
                }
            }
        }
        .task {
            masterOn = Config.notificationsEnabled
            status = await NotifPermission.status()
            await load()
        }
    }

    private var masterBinding: Binding<Bool> {
        Binding(
            get: { masterOn },
            set: { v in
                masterOn = v
                Config.notificationsEnabled = v
                // Drop/restore this device's presence at once so routing (native vs Bark) updates
                // immediately instead of waiting for the next heartbeat.
                NotificationCenter.default.post(name: .presenceShouldRefresh, object: nil)
                if v { Task { await ensurePermission() } }
            },
        )
    }

    /// The whole section while unauthorized: ask, and say what happened if the OS wouldn't ask.
    @ViewBuilder private var permissionRequest: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button("Allow notifications") { Task { await ensurePermission() } }
            Text("Binsight needs permission from macOS before it can alert you.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            if let permissionError {
                // The unsigned-build case: retrying in-app can never succeed, so name the cause
                // instead of leaving the user clicking a button that does nothing.
                Text("macOS refused the request: \(permissionError)")
                    .font(.system(size: 11)).foregroundStyle(Theme.warn)
                Text("A build signed with a real certificate is required for notifications.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var blockedRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Notifications are turned off for Binsight in System Settings.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            Button("Open System Settings") { NotifPermission.openSystemSettings() }
        }
    }

    @ViewBuilder private func row(_ k: Kind) -> some View {
        if let rule = rules[k.key] {
            Toggle(k.name, isOn: enabledBinding(k.key))
            if rule.enabled, k.param != .none {
                HStack {
                    Text(k.param == .sol ? "Threshold (SOL)" : "After (minutes)")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer()
                    paramField(k)
                }
            }
        }
    }

    @ViewBuilder private func paramField(_ k: Kind) -> some View {
        switch k.param {
        case .sol:
            TextField("", value: solBinding(k.key), format: .number)
                .multilineTextAlignment(.trailing).frame(width: 90)
        case .minutes:
            TextField("", value: minutesBinding(k.key), format: .number)
                .multilineTextAlignment(.trailing).frame(width: 90)
        case .none:
            EmptyView()
        }
    }

    private func enabledBinding(_ key: String) -> Binding<Bool> {
        Binding(get: { rules[key]?.enabled ?? false }, set: { v in update(key) { $0.enabled = v } })
    }
    private func solBinding(_ key: String) -> Binding<Double> {
        Binding(get: { rules[key]?.threshold ?? 0 }, set: { v in update(key) { $0.threshold = v } })
    }
    private func minutesBinding(_ key: String) -> Binding<Int> {
        Binding(get: { rules[key]?.oorMinutes ?? 0 }, set: { v in update(key) { $0.oorMinutes = v } })
    }

    private func update(_ key: String, _ mutate: (inout NotifRule) -> Void) {
        guard var r = rules[key] else { return }
        mutate(&r)
        rules[key] = r
        Task { await Backend.saveNotifRule(r) }
    }

    @MainActor private func ensurePermission() async {
        permissionError = nil
        var s = await NotifPermission.status()
        if s == .notDetermined {
            if case .unavailable(let reason) = await NotifPermission.request() {
                permissionError = reason
            }
            s = await NotifPermission.status()
        }
        status = s
        // The permission gates presence (see `notifStatusShowsBanners`): re-report it now.
        NotificationCenter.default.post(name: .presenceShouldRefresh, object: nil)
    }

    @MainActor private func load() async {
        let global = await Backend.notifRules().filter { $0.wallet == nil }
        rules = Dictionary(global.map { ($0.eventKind, $0) }, uniquingKeysWith: { _, latest in latest })
    }
}
