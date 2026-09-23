import BinsightKit
import SwiftUI

/// Portfolio totals, plus the web quick-link and the connection dot (which opens engine health).
struct PanelHeader: View {
    let app: AppController
    @Environment(PortfolioStore.self) private var store
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showHealthDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("PORTFOLIO").font(.system(size: 11, weight: .semibold))
                    .tracking(0.6).foregroundStyle(.secondary)
                Spacer()
                openInBrowserButton
                connectionDot
            }
            if let hint = connectionHint(store.connection, apiURL: Config.apiURL) {
                Text(hint).font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Open Settings below to fix this.").font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            } else if let t = store.totals {
                heroRow(t)
                Divider()
                statStrip(t)
            } else {
                Text("Connecting…").font(.callout).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, PanelLayout.inset)
        .padding(.top, PanelLayout.inset)
        .padding(.bottom, PanelLayout.sectionGap)
    }

    private func heroRow(_ t: PortfolioTotals) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                // These two update every second from the socket. `numericText` transitions only the
                // digits that actually changed, which is the difference between a live readout and a
                // flickering label. Reduce Motion collapses it to an instant swap.
                Text("\(signed(t.uPnlSol)) SOL")
                    .font(.data(28, weight: .semibold))
                    .foregroundStyle(pnlColor(t.uPnlPct))
                    .contentTransition(.numericText(value: t.uPnlSol))
                    .animation(dataAnimation(reduceMotion), value: t.uPnlSol)
                Text(pct2(t.uPnlPct))
                    .font(.data(15, weight: .semibold))
                    .foregroundStyle(pnlColor(t.uPnlPct))
                    .contentTransition(.numericText(value: t.uPnlPct))
                    .animation(dataAnimation(reduceMotion), value: t.uPnlPct)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("WALLET").font(.system(size: 10, weight: .semibold))
                    .tracking(0.5).foregroundStyle(.secondary)
                Text("\(abs4(t.walletTotalSol)) SOL")
                    .font(.data(15, weight: .semibold))
                    .contentTransition(.numericText(value: t.walletTotalSol))
                    .animation(dataAnimation(reduceMotion), value: t.walletTotalSol)
            }
        }
    }

    private func statStrip(_ t: PortfolioTotals) -> some View {
        HStack(alignment: .top, spacing: 0) {
            statCol("Fees", value: "\(abs4(t.feesSol)) SOL") {
                Text(pctOf(t.claimedFeesSol + t.unclaimedFeesSol, t.tvlSol))
                    .font(.data(11)).foregroundStyle(.secondary)
            }
            statCol("TVL", value: "\(abs4(t.tvlSol)) SOL") {
                EmptyView()
            }
            todayCol
        }
    }

    /// Realized PnL since local midnight (updates on close, via /stats), as % of wallet size.
    private var todayCol: some View {
        let today = store.stats?.todayPnlSol ?? 0
        let wallet = store.totals?.walletTotalSol ?? 0
        let color = pnlTone(value: today, basis: 0)
        return VStack(alignment: .leading, spacing: 2) {
            Text("Today").font(.system(size: 11)).foregroundStyle(.secondary)
            Text("\(signed(today)) SOL")
                .font(.data(13, weight: .semibold))
                .foregroundStyle(color)
            Text("\(pctOf(today, wallet)) of wallet")
                .font(.data(11)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func statCol(
        _ label: String, value: String, @ViewBuilder sub: () -> some View,
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
            Text(value).font(.data(13, weight: .semibold))
            sub()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // Discreet quick-link: open the public web app on whatever the panel is currently viewing.
    private var openInBrowserButton: some View {
        Button {
            if let url = webDeepLink { openURL(url) }
        } label: {
            // A symbol, not the app icon: the icon is dark artwork on a dark panel and at 14pt it
            // read as a smudge rather than a control. This also states what the button DOES.
            Image(systemName: "arrow.up.forward.square")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .help("Open in Binsight on the web")
        .accessibilityLabel("Open in Binsight on the web")
        .pointingHandCursor()
    }

    // Mirror the panel's scope: overview → site root, a selected wallet → ?address=<wallet>.
    private var webDeepLink: URL? {
        let base = Config.webURL
        return URL(string: store.scope == "all" ? base : "\(base)/?address=\(store.scope)")
    }

    private var connectionDot: some View {
        let degraded = store.health?.isDegraded ?? false
        let color = connectionColor(store.connection, degraded: degraded)
        let label: String = switch store.connection {
        case .live: degraded ? "degraded" : "live"
        case .connecting: "connecting"
        case .offline: "offline"
        case .unauthorized: "unauthorized"
        case .unconfigured: "setup"
        }
        // A real Button, not a tap gesture on an HStack: this opens the health popover, so it has to
        // be keyboard-focusable and announced as a button rather than as two loose bits of text.
        return Button { showHealthDetail = true } label: {
            HStack(spacing: 4) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Connection: \(label) — open engine health")
        .accessibilityLabel("Connection \(label). Open engine health.")
        .pointingHandCursor()
        .popover(isPresented: $showHealthDetail, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 12) {
                HealthDetailView(health: store.health)
                Button("Reconnect") {
                    showHealthDetail = false
                    app.reconnect()
                }
                .font(.system(size: 12, weight: .medium))
                .buttonStyle(.glass)
            }
            .padding(12)
        }
    }
}
