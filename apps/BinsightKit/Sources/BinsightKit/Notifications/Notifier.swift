import Foundation
import UserNotifications

/// `@unchecked Sendable` is accurate rather than a waiver: the class holds NO stored properties, so
/// the shared instance carries no mutable state across the threads UserNotifications delivers its
/// delegate callbacks on. It exists only to give the notification centre a stable delegate object.
public final class Notifier: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    public static let shared = Notifier()
    override private init() { super.init() }

    /// Call once at launch. Registers the delegate so notifications show even when the app is
    /// active/foreground — the exact case where the backend routes to native instead of Bark.
    ///
    /// Also asks for authorization when macOS has never been asked: the master toggle defaults to on,
    /// so a fresh install would otherwise sit silently unpermitted until someone found Settings. The
    /// OS shows that prompt once at most; after it is answered, `NotificationsEditor` owns the state.
    public static func bootstrap() {
        UNUserNotificationCenter.current().delegate = shared
        Task {
            guard await NotifPermission.status() == .notDetermined else { return }
            _ = await NotifPermission.request()
            // Re-report presence now that the answer is in, rather than on the next heartbeat.
            NotificationCenter.default.post(name: .presenceShouldRefresh, object: nil)
        }
    }

    public func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void,
    ) {
        completionHandler([.banner, .sound, .list])
    }

    public static func show(_ event: LiveEvent) {
        let content = UNMutableNotificationContent()
        content.title = event.title
        content.body = event.body
        content.threadIdentifier = event.pair ?? "portfolio"
        content.sound = .default
        let request = UNNotificationRequest(identifier: event.id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            // Don't black-hole a failed alert (e.g. authorization revoked) — log it so a lost
            // notification is diagnosable rather than silently dropped.
            if let error {
                NSLog("[Notifier] failed to schedule notification: %@", error.localizedDescription)
            }
        }
    }
}
