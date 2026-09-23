import BinsightKit
import Foundation

/// Owns the app's long-lived pieces and wires them together, outside any view.
///
/// The live client used to start in the panel's `.onAppear`, and the app-wide NotificationCenter
/// observers hung off the panel too. `MenuBarExtra` builds that content lazily, on the first click —
/// so after a login-item launch nothing connected: no menu-bar numbers, no native notifications,
/// until someone happened to open the panel. Everything here starts at launch instead.
@MainActor
final class AppController {
    let store: PortfolioStore
    /// The panel's on-demand reads (closed pagination, per-position bins) go through the same client
    /// the live socket resyncs through.
    let rest: RestClient
    let client: LiveClient
    private let presence: MacPresence
    private var observers: [NSObjectProtocol] = []

    init() {
        let store = PortfolioStore()
        let rest = RestClient(store: store)
        let live = LiveClient(store: store, device: .mac)
        live.onSync = { rest.refresh() }
        // A resync that no longer lists the scoped wallet (removed on the web, say) → back to "all".
        rest.onWalletsLoaded = { [weak live] in live?.dropScopeIfUnwatched() }
        let presence = MacPresence()
        live.presenceActive = { presence.isActive } // away/asleep/locked → routes to Bark
        presence.onChange = { [weak live] in live?.refreshPresence() } // flip immediately
        presence.onWake = { [weak live] in live?.reconnect() } // socket is stale after sleep
        self.store = store
        self.rest = rest
        self.client = live
        self.presence = presence

        // Posted from BinsightKit (the notification toggle, a permission answer): update routing now
        // rather than on the next heartbeat.
        observers.append(
            NotificationCenter.default.addObserver(
                forName: .presenceShouldRefresh, object: nil, queue: .main
            ) { [weak live] _ in
                MainActor.assumeIsolated { live?.refreshPresence() }
            })

        Notifier.bootstrap()
        live.start()
    }

    /// Settings saved, or the health popover's Reconnect: an explicit reconnect.
    func reconnect() { client.restart() }

    /// A wallet was removed in Settings: drop its tab now, and leave its scope if the panel was on it
    /// — rather than wait for a resync that only runs while the panel is open.
    func walletRemoved(_ address: String) {
        store.wallets.removeAll { $0.address == address }
        client.dropScopeIfUnwatched()
    }
}
