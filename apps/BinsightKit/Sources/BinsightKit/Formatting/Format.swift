import Foundation
import SwiftUI

public extension Font {
    /// Monospaced-digit data font (SF Mono, ships with the OS — zero project change).
    /// For numeric/tabular values so columns stay aligned as digits change.
    static func data(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced).monospacedDigit()
    }
}

/// Signed SOL value. A magnitude that rounds away to nothing is printed WITHOUT a sign: dust of
/// -0.00001 formatted as "-0.0000", which reads as a loss the position never took.
public func signed(_ n: Double) -> String {
    let magnitude = String(format: "%.4f", abs(n))
    guard magnitude.contains(where: { $0 != "0" && $0 != "." }) else { return magnitude }
    return (n >= 0 ? "+" : "-") + magnitude
}
public func abs4(_ n: Double) -> String { String(format: "%.4f", abs(n)) }
public func abs2(_ n: Double) -> String { String(format: "%.2f", abs(n)) }
/// Signed percent, with the same dust rule as `signed`.
public func pct2(_ n: Double) -> String {
    let magnitude = String(format: "%.2f", abs(n))
    guard magnitude.contains(where: { $0 != "0" && $0 != "." }) else { return magnitude + "%" }
    return (n >= 0 ? "+" : "-") + magnitude + "%"
}
public func short(_ a: String) -> String { a.count > 8 ? "\(a.prefix(4))…\(a.suffix(4))" : a }

public func pctOf(_ part: Double, _ whole: Double) -> String {
    whole == 0 ? "—" : String(format: "%+.2f%%", part / whole * 100)
}

/// Relative age ("3m", "2h", "5d") of an epoch-ms timestamp. `now` is injectable so callers can drive
/// it from a periodic clock (e.g. a `TimelineView`), keeping ages fresh while a view stays on screen
/// instead of only when the view happens to re-render.
public func ageString(_ openedAt: Double?, now: Date = Date()) -> String {
    guard let ms = openedAt, ms > 0 else { return "—" }
    let secs = max(0, now.timeIntervalSince1970 - ms / 1000)
    if secs < 3600 { return "\(Int(secs / 60))m" }
    if secs < 86_400 { return "\(Int(secs / 3600))h" }
    return "\(Int(secs / 86_400))d"
}
