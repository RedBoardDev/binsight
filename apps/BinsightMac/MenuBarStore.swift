import BinsightKit
import SwiftUI

extension MenuBarTone {
    /// Brand colour for a tone. Kept in the app target: `MenuBarSnapshot` stays free of SwiftUI so
    /// its quantisation rule can be unit-tested without a view.
    var color: Color {
        switch self {
        case .profit: Theme.profit
        case .loss: Theme.loss
        case .neutral: .primary
        }
    }
}

extension PortfolioStore {
    /// Glyph shown instead of "0.000 · 0" when connected with nothing open.
    static let idleSymbol = "moon.zzz.fill"
}
