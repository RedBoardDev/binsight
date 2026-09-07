import AppKit
import SwiftUI

/// Brand palette, mapped from the web design tokens (web/src/app/globals.css) so all three
/// clients share one premium-dark identity instead of leaning on system .green/.red/.accentColor.
public enum Theme {
    // Semantic
    public static let profit = Color(hex: 0x3DDC8D)
    public static let loss = Color(hex: 0xFB7185)
    public static let warn = Color(hex: 0xF5B948)
    public static let accent = Color(hex: 0x3DDC8D)
    public static let inRange = Color(hex: 0x3DDC8D)
    public static let outRange = Color(hex: 0xF5B948)

    // Bin-chart sides — mirror the web tokens --color-bin-x / --color-bin-y (globals.css) so the
    // liquidity curve reads the same on the panel as on the site.
    public static let binX = Color(hex: 0xA78BFA)
    public static let binY = Color(hex: 0x38BDF8)

    // Surfaces / chrome greys
    public static let border = Color.white.opacity(0.08)

    // Depth accent: a faint top-edge highlight.
    public static let topHighlight = Color.white.opacity(0.06)

    // Motion tokens — one entrance curve + one press spring, shared by all clients.
    public static let entrance = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.22)
    public static let springPress = Animation.spring(response: 0.3, dampingFraction: 0.8)
}

/// Corner-radius scale for the cinematic-terminal surfaces.
public enum Radius {
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1,
        )
    }
}

/// PnL tone for a SOL value, gated by its percent basis. Neutral when the move is tiny in BOTH
/// dimensions (|pct| ≤ 0.1% and |value| ≤ 0.0001 SOL) so dust doesn't flash green/red.
public func pnlTone(value: Double, basis pct: Double) -> Color {
    if pct > 0.1 || value > 0.0001 { return Theme.profit }
    if pct < -0.1 || value < -0.0001 { return Theme.loss }
    return .primary
}

/// Convenience for percent-only callers (PnL % already carries the sign/magnitude).
public func pnlColor(_ pct: Double) -> Color { pnlTone(value: 0, basis: pct) }

/// Dot/label colour for a connection state, optionally flagged degraded (live but a source is down).
public func connectionColor(_ state: ConnectionState, degraded: Bool = false) -> Color {
    switch state {
    case .live: return degraded ? Theme.warn : Theme.profit
    case .connecting: return Theme.warn
    case .offline, .unauthorized: return Theme.loss
    case .unconfigured: return .secondary
    }
}

func isOut(_ s: RangeStatus) -> Bool { s == .out_up || s == .out_down }

public extension View {
    /// Show the macOS pointing-hand cursor while hovering a clickable control.
    func pointingHandCursor() -> some View {
        modifier(PointingHandCursor())
    }

    /// Shared data-update animation: snap instantly under reduce-motion, else the entrance curve.
    /// Used by the bin chart so its marker snaps instead of sliding under reduce-motion.
    func dataAnimation(_ reduceMotion: Bool) -> Animation {
        reduceMotion ? .linear(duration: 0.01) : Theme.entrance
    }

    /// Material-free card surface: solid fill + clipped continuous corners + 1px hairline stroke +
    /// a faint top-edge highlight. Depth from material, not glassmorphism.
    func cardSurface(radius: CGFloat = Radius.md, elevated: Bool = false) -> some View {
        modifier(CardSurface(radius: radius, elevated: elevated))
    }
}

/// Pointing-hand cursor while hovering. See `View.pointingHandCursor()`.
///
/// Pops the cursor on DISAPPEAR as well as on exit, and only ever pops what it pushed. A menu-bar
/// popover is routinely dismissed while the pointer is still inside it (clicking a quick-link closes
/// it), and a row can be replaced by a live data update under the pointer — in both cases
/// `onHover(false)` never arrives, so a bare push/pop pair leaks a cursor onto the system stack and
/// the hand sticks over unrelated apps for the rest of the session.
struct PointingHandCursor: ViewModifier {
    @State private var pushed = false

    func body(content: Content) -> some View {
        content
            .onHover { hovering in
                if hovering { push() } else { pop() }
            }
            .onDisappear(perform: pop)
    }

    private func push() {
        guard !pushed else { return }
        pushed = true
        NSCursor.pointingHand.push()
    }

    private func pop() {
        guard pushed else { return }
        pushed = false
        NSCursor.pop()
    }
}

/// Reusable cinematic-terminal card chrome. See `View.cardSurface(radius:elevated:)`.
public struct CardSurface: ViewModifier {
    let radius: CGFloat
    let elevated: Bool

    public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return content
            .background(fill)
            .clipShape(shape)
            .overlay(shape.strokeBorder(Theme.border, lineWidth: 1))
            .overlay(
                LinearGradient(
                    colors: [Theme.topHighlight, .clear],
                    startPoint: .top,
                    endPoint: .bottom,
                )
                .frame(height: 1.5)
                .frame(maxHeight: .infinity, alignment: .top)
                .clipShape(shape)
                .allowsHitTesting(false),
            )
    }

    /// Card fill — a faint light lift over the panel's translucent material so the card reads as a
    /// *raised* surface instead of an opaque dark patch. Nudged up from 0.07/0.10: over a bright or
    /// saturated backdrop the cards were reading muddy rather than raised. Kept deliberately small,
    /// because the depth is meant to come from the material, not from painting over it.
    private var fill: Color {
        Color.white.opacity(elevated ? 0.125 : 0.095)
    }
}
