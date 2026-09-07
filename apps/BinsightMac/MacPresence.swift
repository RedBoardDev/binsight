import AppKit
import CoreGraphics
import Foundation

/// Presence detection for macOS: "active" only when you're really at the Mac — awake,
/// screen unlocked, and not idle (no keyboard/mouse input) for more than `awaySeconds`.
/// Sleep/wake/lock/unlock flip immediately via `onChange`; idle is sampled by the heartbeat.
///
/// @MainActor because every observer below is registered with `queue: .main` and the only reader
/// (`LiveClient`) is itself main-actor isolated. Stating that makes the `@Sendable` observer closures
/// provably safe instead of merely conventionally safe.
@MainActor
final class MacPresence {
    /// Called on awake/sleep/lock/unlock so the client can push a presence update immediately.
    var onChange: () -> Void = {}
    /// Called on wake-from-sleep so the client can drop the stale socket and reconnect.
    var onWake: () -> Void = {}

    private let awaySeconds: Double = 300 // 5 min without input → considered away
    private var awake = true
    private var locked = false

    init() {
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) {
            [weak self] _ in
            MainActor.assumeIsolated { self?.update { $0.awake = false } }
        }
        workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) {
            [weak self] _ in
            MainActor.assumeIsolated {
                self?.update { $0.awake = true }
                self?.onWake()
            }
        }
        let distributed = DistributedNotificationCenter.default()
        distributed.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) {
            [weak self] _ in
            MainActor.assumeIsolated { self?.update { $0.locked = true } }
        }
        distributed.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) {
            [weak self] _ in
            MainActor.assumeIsolated { self?.update { $0.locked = false } }
        }
    }

    /// True when present at the Mac.
    var isActive: Bool {
        guard awake, !locked else { return false }
        return Self.idleSeconds() < awaySeconds
    }

    private func update(_ mutate: (MacPresence) -> Void) {
        mutate(self)
        onChange()
    }

    /// Seconds since the last HID (keyboard/mouse) input. `nonisolated`: it touches no instance state.
    ///
    /// Core Graphics answers this directly. The previous implementation matched the IOHIDSystem
    /// service and then COPIED its whole property dictionary — on every heartbeat, for the life of
    /// the process — to read a single key out of it.
    private nonisolated static func idleSeconds() -> Double {
        CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .null)
    }
}
