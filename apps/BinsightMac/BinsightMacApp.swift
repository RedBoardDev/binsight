import BinsightKit
import SwiftUI

/// The menu-bar label, in its OWN view so `@Observable` tracking is scoped to it.
///
/// Read inline in `App.body`, every store mutation invalidated the whole scene: profiling a resting
/// app showed `BinsightMacApp.body.getter` on the 1 Hz socket path, re-evaluating the scene tree —
/// and re-creating the panel's six publisher subscriptions — once a second, forever. Now only this
/// `Text` re-renders.
private struct MenuBarLabel: View {
    let store: PortfolioStore

    var body: some View {
        // Reads ONE observable value — the rendered snapshot — so the label re-renders only when its
        // own content changes, not whenever any portfolio number moves.
        let snapshot = store.menuBar
        if let text = snapshot.text {
            Text(text)
                // Dimmed while stale: the figures are the last known ones, not live ones.
                .foregroundStyle(snapshot.isStale ? .secondary : snapshot.tone.color)
                .monospacedDigit()
        } else {
            Image(systemName: PortfolioStore.idleSymbol) // menu bar = single static glyph
        }
    }
}

@main
struct BinsightMacApp: App {
    // No inline initializers: init() builds the wired instances. Inline `= PortfolioStore()` /
    // `= MacPresence()` would construct THROWAWAY instances (the MacPresence one registering — then
    // leaking — its 4 system observers) before init() overwrites the backing State.
    @State private var store: PortfolioStore
    @State private var client: LiveClient
    @State private var presence: MacPresence
    // Held so the panel's on-demand reads (closed pagination, per-position bins) reach the same
    // client the live socket resyncs through.
    private let rest: RestClient

    init() {
        let store = PortfolioStore()
        let rest = RestClient(store: store)
        let live = LiveClient(store: store, device: .mac)
        live.onSync = { rest.refresh() }
        let presence = MacPresence()
        live.presenceActive = { presence.isActive } // away/asleep/locked → routes to Bark
        presence.onChange = { [weak live] in live?.refreshPresence() } // flip immediately
        presence.onWake = { [weak live] in live?.reconnect() } // socket is stale after sleep
        _store = State(initialValue: store)
        _client = State(initialValue: live)
        _presence = State(initialValue: presence)
        self.rest = rest
        Notifier.bootstrap()
    }

    var body: some Scene {
        MenuBarExtra {
            PanelView()
                .environment(store)
                .tint(Theme.accent) // emerald brand accent for controls/links
                .preferredColorScheme(.dark) // premium-dark identity holds even in system light mode
                .onAppear {
                    store.panelVisible = true
                    client.start()
                    // Everything the REST client fetches is only visible here, so it stays idle
                    // until the panel is actually on screen (and flushes one deferred resync now).
                    rest.panelDidAppear()
                }
                .onDisappear {
                    store.panelVisible = false
                    rest.panelDidDisappear()
                }
                .onReceive(NotificationCenter.default.publisher(for: .reconnect)) { _ in
                    client.stop()
                    client.start()
                }
                .onReceive(NotificationCenter.default.publisher(for: .refresh)) { _ in
                    client.refreshNow()
                }
                .onReceive(NotificationCenter.default.publisher(for: .presenceShouldRefresh)) { _ in
                    client.refreshPresence() // notif toggle flipped → update routing now
                }
                .onReceive(NotificationCenter.default.publisher(for: .setScope)) { note in
                    if let scope = note.object as? String { client.setScope(scope) }
                }
                .onReceive(NotificationCenter.default.publisher(for: .loadMoreClosed)) { _ in
                    rest.loadMoreClosed()
                }
                .onReceive(NotificationCenter.default.publisher(for: .needBins)) { note in
                    if let address = note.object as? String { rest.loadBins(for: address) }
                }
        } label: {
            MenuBarLabel(store: store)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
        }
    }
}
