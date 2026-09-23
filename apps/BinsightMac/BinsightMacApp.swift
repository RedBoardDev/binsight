import BinsightKit
import SwiftUI

/// The menu-bar label, in its OWN view so `@Observable` tracking is scoped to it.
///
/// Read inline in `App.body`, every store mutation invalidated the whole scene: profiling a resting
/// app showed `BinsightMacApp.body.getter` on the 1 Hz socket path, re-evaluating the scene tree
/// once a second, forever. Now only this `Text` re-renders.
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
    // No inline initializer: init() builds the one controller. An inline `= AppController()` next to
    // an init() assignment would construct a THROWAWAY one first — a second socket, and MacPresence's
    // four system observers registered and leaked.
    @State private var app: AppController

    init() {
        // Connects right here, at launch: the panel's content is built lazily on the first click,
        // which is far too late for the menu-bar readout and native notifications.
        _app = State(initialValue: AppController())
    }

    var body: some Scene {
        MenuBarExtra {
            PanelView(app: app)
                .environment(app.store)
                .tint(Theme.accent) // emerald brand accent for controls/links
                .preferredColorScheme(.dark) // premium-dark identity holds even in system light mode
                .onAppear {
                    app.store.panelVisible = true
                    // Everything the REST client fetches is only visible here, so it stays idle
                    // until the panel is actually on screen (and flushes one deferred resync now).
                    app.rest.panelDidAppear()
                }
                .onDisappear {
                    app.store.panelVisible = false
                    app.rest.panelDidDisappear()
                }
        } label: {
            MenuBarLabel(store: app.store)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(app: app)
        }
    }
}
