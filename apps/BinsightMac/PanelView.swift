import BinsightKit
import SwiftUI

/// How often the open panel re-renders so relative ages stay current. Ages tick in minutes, so a 30 s
/// cadence keeps them effectively fresh while the panel is open without re-rendering on every frame.
private let ageRefreshSeconds: TimeInterval = 30

struct PanelView: View {
    @Environment(PortfolioStore.self) private var store
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showHealthDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // A single wallet makes "Overview" (the all-wallets aggregate) redundant — it equals that
            // wallet — so the whole scope bar is hidden until there are at least two wallets.
            if store.wallets.count > 1 {
                tabs
                Divider()
            }
            header
            Divider()
            contentScroll
            Divider()
            footer
        }
        .frame(width: 360)
        .background(panelBackground)
    }

    /// Vibrant material by default; an opaque surface under Reduce Transparency. The panel's dense
    /// numeric text otherwise sits on whatever happens to be behind the menu bar, which is exactly
    /// the legibility problem that setting exists to fix.
    @ViewBuilder private var panelBackground: some View {
        if reduceTransparency {
            Color(nsColor: .windowBackgroundColor)
        } else {
            Rectangle().fill(.regularMaterial)
        }
    }

    // MARK: Tabs (Overview + one per wallet)

    private var tabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                tab("Overview", scope: "all")
                ForEach(store.wallets) { w in
                    tab(w.label.isEmpty ? short(w.address) : w.label, scope: w.address)
                }
            }
            .padding(.horizontal, Self.inset)
            .padding(.vertical, 8)
        }
    }

    private func tab(_ title: String, scope: String) -> some View {
        TabChip(title: title, active: store.scope == scope) {
            NotificationCenter.default.post(name: .setScope, object: scope)
        }
    }

    // MARK: Header (portfolio totals)

    private var header: some View {
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
        .padding(.horizontal, Self.inset)
        .padding(.top, Self.inset)
        .padding(.bottom, Self.sectionGap)
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

    // Open positions get their own bounded box so a long open list no longer pushes the closed history
    // far down a single shared scroll. Beyond `openScrollThreshold` cards the box switches from hugging
    // its content to a fixed, scrolling height (a pure count test — no layout measurement).
    // ── Spacing scale ─────────────────────────────────────────────────────────────────────────────
    // Every section previously carried its own insets (16 for the header, 10 for the open list, 12
    // for the closed list), so PORTFOLIO sat further right than OPEN POSITIONS and the closed rows
    // ended short of the cards' right edge. One scale, applied to labels, cards, rows and footer
    // alike, is what makes the panel read as a single surface instead of three stacked ones.
    /// Distance from the panel edge to any section label, card or row.
    private static let inset: CGFloat = 14
    /// Gap above a section label (below the separator that precedes it).
    private static let sectionGap: CGFloat = 12
    /// Gap between a section label and its first row.
    private static let labelGap: CGFloat = 6

    private static let openScrollThreshold = 3 // above this many open cards, the box scrolls
    private static let openScrollCap: CGFloat = 320 // open box height once it scrolls (≈ threshold cards)
    // Rows left below the last visible one before the next closed page is pulled — a small prefetch so
    // the list doesn't visibly stall at the bottom.
    private static let closedPrefetchRows = 3
    private static let closedScrollHeight: CGFloat = 220 // closed-history box height (always scrolls)

    // MARK: Scrollable content (open + closed each in their own bounded scroll; labels/header/footer fixed)

    private var contentScroll: some View {
        // One timeline drives both lists so relative ages ("3m", "2h") stay fresh while the panel is open —
        // previously an age only updated when its row happened to re-render (hover).
        TimelineView(.periodic(from: .now, by: ageRefreshSeconds)) { ctx in
            VStack(alignment: .leading, spacing: 0) {
                openHeader // fixed: only the cards below scroll
                openScrollBox(now: ctx.date)
                Divider() // full width, matching the header separator — was inset by 10

                closedBar // fixed closed-history header
                ScrollView { closedList(now: ctx.date) }
                    .frame(height: Self.closedScrollHeight)
                    .scrollBounceBehavior(.basedOnSize)
                    .mask(closedFadeMask)
            }
        }
    }

    private var openHeader: some View {
        sectionLabel("OPEN POSITIONS", count: store.positions.count)
            .padding(.horizontal, Self.inset)
            .padding(.top, Self.sectionGap)
            .padding(.bottom, Self.labelGap)
    }

    /// Few open positions → the cards hug their content (no blank gap). Many → a fixed-height scroll so a
    /// long list can't push the closed history off-screen.
    @ViewBuilder private func openScrollBox(now: Date) -> some View {
        if store.positions.count > Self.openScrollThreshold {
            ScrollView { openCards(now: now) }
                .frame(height: Self.openScrollCap)
                .scrollBounceBehavior(.basedOnSize)
        } else {
            openCards(now: now)
        }
    }

    private func openCards(now: Date) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if store.positions.isEmpty {
                Text(store.wallets.isEmpty ? "Add a wallet in Settings to start" : "No open positions")
                    .font(.system(size: 12)).foregroundStyle(.secondary).padding(.vertical, 6)
            } else {
                ForEach(store.positions) { p in
                    PositionCard(p: p, now: now, bins: store.bins[p.positionAddress])
                        // Per-card, on-demand: asks once per position each time the panel opens, and
                        // the store's TTL/in-flight claim drops the ask when a snapshot is still
                        // fresh — so reopening the panel costs nothing.
                        .task(id: p.positionAddress) {
                            NotificationCenter.default.post(
                                name: .needBins, object: p.positionAddress)
                        }
                }
            }
        }
        .padding(.horizontal, Self.inset).padding(.bottom, Self.sectionGap)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Closed history (scrolls independently)

    /// Softens the bottom edge of the closed box, whose fixed height necessarily cuts a row in half.
    /// A hard clip mid-row looks like a rendering fault; a fade reads as "there is more below".
    private var closedFadeMask: some View {
        LinearGradient(
            stops: [
                .init(color: .black, location: 0),
                .init(color: .black, location: 1 - Self.closedFadeFraction),
                .init(color: .clear, location: 1),
            ],
            startPoint: .top,
            endPoint: .bottom,
        )
    }

    /// Share of the closed box's height taken by the bottom fade — about one row, no more: enough to
    /// soften the cut without dimming a row the user is trying to read.
    private static let closedFadeFraction = 0.12

    private var closedBar: some View {
        HStack(spacing: 8) {
            Text("CLOSED\(store.closedTotal > 0 ? " (\(store.closedTotal))" : "")")
                .font(.system(size: 11, weight: .semibold)).tracking(0.6)
                .foregroundStyle(.secondary)
            if let s = store.stats {
                Text(signed(s.totalPnlSol)).font(.data(11))
                    .foregroundStyle(s.totalPnlSol >= 0 ? Theme.profit : Theme.loss)
                Text("· win \(Int(s.winRate))%").font(.data(11)).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, Self.inset)
        .padding(.top, Self.sectionGap)
        .padding(.bottom, Self.labelGap)
    }

    private func closedList(now: Date) -> some View {
        // LazyVStack, not VStack: it is what makes `onAppear` mean "scrolled into view". A plain VStack
        // lays every row out at once, so the prefetch below would chain-load the whole history on open.
        LazyVStack(spacing: 0) {
            if store.closed.isEmpty {
                Text("No closed positions yet").font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                ForEach(Array(store.closed.enumerated()), id: \.element.id) { index, c in
                    ClosedRow(c: c, now: now)
                        .onAppear { prefetchClosed(reaching: index) }
                }
                if store.hasMoreClosed {
                    loadingMoreFooter
                } else if store.closedTruncatedByCap {
                    closedCapFooter
                }
            }
        }
        .padding(.horizontal, Self.inset)
        .padding(.bottom, 8)
    }

    /// Scrolling into the last few loaded rows pulls the next page. Repeated calls are free: the store's
    /// in-flight claim and `hasMoreClosed` drop every ask that isn't the one page actually missing.
    private func prefetchClosed(reaching index: Int) {
        guard store.hasMoreClosed, index >= store.closed.count - Self.closedPrefetchRows else { return }
        NotificationCenter.default.post(name: .loadMoreClosed, object: nil)
    }

    /// Foot of the list while more history exists — a status line, not a button: pagination is
    /// automatic, so there is nothing for the user to click.
    private var loadingMoreFooter: some View {
        Text("\(store.closed.count) of \(store.closedTotal)")
            .font(.data(11))
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .accessibilityLabel(
                "Showing \(store.closed.count) of \(store.closedTotal) closed positions")
    }

    /// Shown once pagination stops at the retention cap, so the list doesn't just fall silent as if
    /// the history had ended.
    private var closedCapFooter: some View {
        Text("First \(store.closed.count) of \(store.closedTotal) — full history on the web")
            .font(.system(size: 11))
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity)
            .multilineTextAlignment(.center)
            .padding(.vertical, 6)
    }

    // MARK: Footer (icon menu rows)

    private var footer: some View {
        VStack(spacing: 2) {
            SettingsLink { menuLabel("gearshape", "Settings") }
                .buttonStyle(HoverRowStyle())
            Button { NSApplication.shared.terminate(nil) } label: {
                menuLabel("power", "Quit")
            }
            .buttonStyle(HoverRowStyle())
        }
        .padding(6)
    }

    /// Footer rows carry their own padding so the hover highlight has room to breathe; `6` on the
    /// footer plus `8` here lands the icon on `inset`, in line with every section label above.
    private func menuLabel(_ icon: String, _ label: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).frame(width: 18).foregroundStyle(.secondary)
            Text(label).font(.system(size: 13))
            Spacer()
        }
        .contentShape(Rectangle())
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }

    // MARK: Shared bits

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
        let degraded = store.health.map { !$0.wsConnected || !$0.meteoraOk } ?? false
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
                    NotificationCenter.default.post(name: .reconnect, object: nil)
                }
                .font(.system(size: 12, weight: .medium))
                .buttonStyle(.glass)
            }
            .padding(12)
        }
    }

    private func sectionLabel(_ title: String, count: Int) -> some View {
        HStack {
            // Same tracking as the PORTFOLIO/CLOSED labels — all-caps at 11pt needs the extra
            // letter-spacing, and having only one of the three carry it read as a mistake.
            Text(title).font(.system(size: 11, weight: .semibold)).tracking(0.6)
                .foregroundStyle(.secondary)
            Spacer()
            Text("\(count)").font(.data(11)).foregroundStyle(.secondary)
        }
    }
}

/// A closed-position row: pair on the left, stats on the right. The quick-links (LPAgent / GMGN /
/// share) stay hidden until the row is hovered — appearing beside the stats — to keep the list clean.
private struct ClosedRow: View {
    let c: ClosedPosition
    let now: Date
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            Text("\(c.tokenX)/\(c.tokenY)")
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
            Spacer()
            // Hover reveals the quick-links; at rest the same slot shows a discreet size summary.
            // Both are always laid out (ZStack) so the row never resizes between states.
            ZStack(alignment: .trailing) {
                PositionLinks(
                    wallet: c.wallet, positionAddress: c.positionAddress, mint: c.tokenXMint,
                    shareAddress: c.positionAddress)
                    .opacity(hovering ? 1 : 0)
                    .allowsHitTesting(hovering)
                restingSummary
                    .opacity(hovering ? 0 : 1)
                    .allowsHitTesting(false)
            }
            Text(signed(c.pnlSol))
                .font(.data(12, weight: .semibold))
                .foregroundStyle(pnlColor(c.pnlPctSol))
            // Fees, glyph-free (the old ⓒ read as a copyright mark). In a tabular row the dim
            // treatment and fixed column already separate this from the PnL beside it; the tooltip
            // and VoiceOver label name it for anyone who needs telling.
            Text(abs4(c.feesSol))
                .font(.data(11))
                .foregroundStyle(.secondary)
                .fixedSize()
                .help("Fees earned")
                .accessibilityLabel("fees \(abs4(c.feesSol)) SOL")
            Text(ageString(c.closedAt, now: now))
                .font(.data(11))
                .foregroundStyle(.tertiary)
                .fixedSize()
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onHover { h in withAnimation(Theme.springPress) { hovering = h } }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(spokenSummary)
    }

    /// Spoken form of the row: the same facts the columns show, in reading order.
    private var spokenSummary: String {
        let pnl = "PnL \(signed(c.pnlSol)) SOL, \(String(format: "%+.2f", c.pnlPctSol)) percent"
        return "\(c.tokenX) \(c.tokenY) closed \(ageString(c.closedAt, now: now)) ago. "
            + "\(pnl). Fees \(abs4(c.feesSol)) SOL. Deposited \(abs2(c.depositSol)) SOL."
    }

    // Size (deposited SOL, 2 dp) — shown only while the row is at rest. The DLMM shape is
    // deliberately NOT repeated here: on a closed position it no longer tells you anything
    // actionable, and it was crowding the row's one free slot.
    private var restingSummary: some View {
        Text("\(abs2(c.depositSol)) SOL")
            .font(.data(11))
            .foregroundStyle(.tertiary)
            .fixedSize()
    }
}

/// Scope tab with a hover affordance (subtle bg on the inactive tab) + pointing-hand cursor.
private struct TabChip: View {
    let title: String
    let active: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(background, in: Capsule())
                .foregroundStyle(active ? Theme.accent : .secondary)
        }
        .buttonStyle(.plain)
        .onHover { h in
            hovering = h
            if h { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }

    private var background: Color {
        if active { return Theme.accent.opacity(0.22) }
        return hovering ? Color.primary.opacity(0.07) : .clear
    }
}
