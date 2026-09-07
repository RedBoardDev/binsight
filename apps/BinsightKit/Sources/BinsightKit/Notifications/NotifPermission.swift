import AppKit
import UserNotifications

/// Result of asking for notification authorization.
public enum NotifRequestOutcome: Equatable, Sendable {
    case granted
    /// The user declined the system prompt.
    case denied
    /// The OS refused to present the prompt at all. On macOS the usual cause is a build without a
    /// real code signature (ad-hoc / linker-signed): `UNUserNotificationCenter` only registers a
    /// properly signed bundle, so no amount of retrying in-app will help.
    case unavailable(String)
}

/// What the Notifications section should offer. Derived from the OS permission first and the local
/// master switch second — pure, so that precedence is pinned by tests instead of being tangled into
/// the view body.
public enum NotifSectionState: Equatable, Sendable {
    /// Permission never requested: the only control worth showing is the request itself. A master
    /// switch here would promise delivery the OS has not agreed to.
    case needsPermission
    /// Explicitly denied — only System Settings can undo it.
    case blockedInSystemSettings
    /// Granted: show the master switch, plus the per-event rules when it is on.
    case ready(rulesVisible: Bool)
}

public func notifSectionState(status: UNAuthorizationStatus, masterOn: Bool) -> NotifSectionState {
    switch status {
    case .authorized, .provisional: .ready(rulesVisible: masterOn)
    case .denied: .blockedInSystemSettings
    default: .needsPermission
    }
}

/// Notification authorization helpers.
public enum NotifPermission {
    public static func status() async -> UNAuthorizationStatus {
        await withCheckedContinuation { cont in
            UNUserNotificationCenter.current().getNotificationSettings { s in
                cont.resume(returning: s.authorizationStatus)
            }
        }
    }

    /// Prompts the user (only effective while status is .notDetermined).
    ///
    /// Distinguishes "the user said no" from "the OS refused to even ask" — the latter is the common
    /// case on a locally-built, unsigned menu-bar app, and used to look like a dead button.
    public static func request() async -> NotifRequestOutcome {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            return granted ? .granted : .denied
        } catch {
            return .unavailable(error.localizedDescription)
        }
    }

    /// Opens the OS notification settings for this app (used when already denied).
    public static func openSystemSettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")
        if let url { NSWorkspace.shared.open(url) }
    }
}
