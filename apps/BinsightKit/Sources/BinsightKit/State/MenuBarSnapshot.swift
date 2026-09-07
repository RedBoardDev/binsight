import Foundation

/// Tone of the menu-bar readout. An enum, not a `Color`: the tone has three states, while the percent
/// it derives from is a live float — comparing colours-as-numbers would defeat the whole point.
public enum MenuBarTone: Sendable, Equatable { case profit, loss, neutral }

/// Exactly what the menu bar renders, and nothing more.
///
/// This is the only thing on screen while the panel is closed — which is nearly always. The label
/// shows PnL to three decimals plus the open count, whereas `PortfolioTotals` carries eleven live
/// floats (fees, TVL, idle, …) that move every second. Comparing whole totals therefore still
/// invalidated the label once a second for digits it does not display. Comparing THIS invalidates it
/// only when the rendered text or its tone actually changes, so a resting portfolio renders zero
/// times per second instead of one.
public struct MenuBarSnapshot: Sendable, Equatable {
    /// Nil while nothing is worth showing but a glyph (connected, no open positions).
    public let text: String?
    public let tone: MenuBarTone
    /// Carried so the store can tell a STRUCTURAL change (a position opened or closed) from a digit
    /// drifting — the two deserve very different urgency. See `menuBarThrottleSeconds`.
    public let openCount: Int
    /// The socket is down, so these numbers are frozen at whatever they last were. Rendered dimmed:
    /// a menu bar that shows a confident PnL while disconnected is worse than one that shows none,
    /// and this app is meant to sit there for weeks.
    public let isStale: Bool

    public init(text: String?, tone: MenuBarTone, openCount: Int = 0, isStale: Bool = false) {
        self.text = text
        self.tone = tone
        self.openCount = openCount
        self.isStale = isStale
    }

    /// Whether `other` differs in a way the user should see immediately, rather than at the next
    /// throttle window: the glyph/text mode, the gain-vs-loss tone, or the number of open positions.
    public func differsStructurally(from other: MenuBarSnapshot) -> Bool {
        isIdle != other.isIdle || tone != other.tone || openCount != other.openCount
            || isStale != other.isStale
    }

    /// Connected with nothing open → a single static glyph rather than "0.000 · 0".
    public var isIdle: Bool { text == nil }
}

/// Derives the menu-bar readout. Pure, so the quantisation rule that keeps the app quiet is pinned by
/// tests rather than buried in a view.
///
/// macOS renders the menu-bar label as a monochrome template (foregroundStyle is ignored there), so
/// the +/- sign — not the tone — is what carries gain vs loss for the user.
public func menuBarSnapshot(connection: ConnectionState, totals: PortfolioTotals?)
    -> MenuBarSnapshot
{
    switch connection {
    case .unconfigured: return MenuBarSnapshot(text: "Setup", tone: .neutral)
    // Both are actionable in Settings, and neither should wear a stale number as if it were live.
    case .unauthorized: return MenuBarSnapshot(text: "Auth", tone: .loss)
    default: break
    }
    // Offline keeps the last known figures — they are still the best answer available — but says so.
    let stale = connection == .offline
    guard let totals else { return MenuBarSnapshot(text: "—", tone: .neutral, isStale: stale) }
    if connection == .live, totals.openCount == 0 {
        return MenuBarSnapshot(text: nil, tone: .neutral, openCount: 0)
    }
    let sign = totals.uPnlSol >= 0 ? "+" : ""
    let text = "\(sign)\(String(format: "%.3f", totals.uPnlSol)) · \(totals.openCount)"
    let tone: MenuBarTone =
        if totals.uPnlPct > 0.1 {
            .profit
        } else if totals.uPnlPct < -0.1 {
            .loss
        } else {
            .neutral
        }
    return MenuBarSnapshot(
        text: text, tone: tone, openCount: totals.openCount, isStale: stale)
}

/// How often the menu-bar readout is allowed to change on a mere digit move.
///
/// The label is a glance, not a chart: nobody tracks the third decimal of an unopened menu-bar item,
/// and each change costs a status-item relayout plus a trip to the window server. Structural changes
/// (a position opened or closed, gain flipping to loss, the connection dropping) bypass this and go
/// out at once. The panel itself, when open, still renders the full 1 Hz stream.
public let menuBarThrottleSeconds: TimeInterval = 5
