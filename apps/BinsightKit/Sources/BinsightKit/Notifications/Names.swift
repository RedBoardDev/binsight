import Foundation

/// Cross-target NotificationCenter names, shared so every target references the same
/// constants instead of redeclaring them. Only for what BinsightKit's own views must tell the host
/// app; the app's views call its controller directly.
public extension Notification.Name {
    /// Posted when the local "Enable notifications" master toggle or the OS permission changes, so
    /// the host app can push a fresh presence heartbeat immediately (muting a device must route to
    /// Bark at once, not after the next 10s heartbeat).
    static let presenceShouldRefresh = Notification.Name("BinsightPresenceShouldRefresh")
}
