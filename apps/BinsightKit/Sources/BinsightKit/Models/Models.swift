import Foundation

// Wire types mirroring @binsight/shared. Only the fields the clients render.

public enum RangeStatus: String, Codable, Sendable { case `in`, out_up, out_down, unknown }

/// DLMM liquidity shape the position was opened with, resolved server-side from the open transaction.
/// Raw values match the wire enum (`@binsight/shared`). Nil until resolved (or if resolution failed).
public enum StrategyFamily: String, Codable, Sendable {
    case spot = "Spot"
    case curve = "Curve"
    case bidAsk = "BidAsk"
}

/// Client-side Solana address validation, mirrors the server's WalletSchema (base58, 32–44 chars;
/// rejects 0x/EVM & junk). A local guard so an obviously-malformed address never hits the network —
/// the backend re-validates.
public enum SolanaAddress {
    public static func isValid(_ s: String) -> Bool {
        s.trimmingCharacters(in: .whitespacesAndNewlines)
            .range(of: "^[1-9A-HJ-NP-Za-km-z]{32,44}$", options: .regularExpression) != nil
    }
}

public struct PortfolioTotals: Codable, Sendable, Equatable {
    public let uPnlSol: Double
    public let uPnlPct: Double
    public let feesSol: Double
    public let claimedFeesSol: Double
    public let unclaimedFeesSol: Double
    public let tvlSol: Double
    public let idleSol: Double
    public let walletTotalSol: Double
    public let openCount: Int
    public let inRangeCount: Int
    public let outOfRangeCount: Int
}

public struct OpenPosition: Codable, Identifiable, Sendable, Equatable {
    public var id: String { positionAddress }
    public let positionAddress: String
    public let wallet: String
    public let tokenX: String
    public let tokenY: String
    public let tokenXMint: String
    public let sizeSol: Double
    public let pnlSol: Double
    public let pnlPctSol: Double
    public let claimedFeesSol: Double
    public let unclaimedFeesSol: Double
    /// Native pool quote (SOL, USDC or USDT). Optional: rows written before the quote-aware sync, and
    /// older servers, omit these — every reader falls back to the SOL fields below.
    public let tokenYMint: String?
    public let quoteSymbol: String?
    public let sizeQuote: Double?
    public let pnlQuote: Double?
    public let pnlPctQuote: Double?
    public let claimedFeesQuote: Double?
    public let unclaimedFeesQuote: Double?
    public let rangeStatus: RangeStatus
    public let minPrice: Double
    public let maxPrice: Double
    public let poolPrice: Double?
    public let openedAt: Double?
    public let strategy: StrategyFamily?

    /// What this position's economics are actually denominated in. A USDC pool reports zero in every
    /// SOL column, so reading those would show a real trade as a flat, wrong zero.
    public var nativeQuote: String { quoteSymbol ?? "SOL" }
    public var displaySize: Double { sizeQuote ?? sizeSol }
    public var displayPnl: Double { pnlQuote ?? pnlSol }
    public var displayPnlPct: Double { pnlPctQuote ?? pnlPctSol }
    public var displayFees: Double {
        (claimedFeesQuote ?? claimedFeesSol) + (unclaimedFeesQuote ?? unclaimedFeesSol)
    }
}

public struct WalletState: Codable, Sendable {
    public let scope: String
    public let totals: PortfolioTotals
    public let openPositions: [OpenPosition]
}

public struct ClosedPosition: Codable, Identifiable, Sendable {
    public var id: String { positionAddress }
    public let positionAddress: String
    public let wallet: String
    public let tokenX: String
    public let tokenY: String
    public let tokenXMint: String
    public let pnlSol: Double
    public let pnlPctSol: Double
    public let feesSol: Double
    public let depositSol: Double
    /// See `OpenPosition` — native pool quote, optional for older rows/servers.
    public let tokenYMint: String?
    public let quoteSymbol: String?
    public let pnlQuote: Double?
    public let pnlPctQuote: Double?
    public let feesQuote: Double?
    public let depositQuote: Double?
    public let withdrawQuote: Double?
    public let closedAt: Double?
    /// DLMM shape the position was opened with. Travels with the position into closed status; nil for
    /// historical closes the server never observed open (so the badge simply doesn't show).
    public let strategy: StrategyFamily?

    public var nativeQuote: String { quoteSymbol ?? "SOL" }
    public var displayPnl: Double { pnlQuote ?? pnlSol }
    public var displayPnlPct: Double { pnlPctQuote ?? pnlPctSol }
    public var displayFees: Double { feesQuote ?? feesSol }
    public var displayDeposit: Double { depositQuote ?? depositSol }
}

public struct ClosedPage: Codable, Sendable {
    public let rows: [ClosedPosition]
    public let total: Int
}

/// One price bin of an open position: its price and the (UI) token amounts held there.
/// Mirrors `PositionBinSchema` in `@binsight/shared`.
public struct PositionBin: Codable, Sendable {
    public let binId: Int
    /// Price of token X in token Y (UI units).
    public let price: Double
    public let amountX: Double
    public let amountY: Double

    public init(binId: Int, price: Double, amountX: Double, amountY: Double) {
        self.binId = binId
        self.price = price
        self.amountX = amountX
        self.amountY = amountY
    }
}

/// Per-bin liquidity distribution of ONE open position at a single slot — the data behind the card's
/// bin chart. Mirrors `PositionBinsSchema` in `@binsight/shared` (only the fields the chart renders).
public struct PositionBins: Codable, Sendable {
    public let slot: Int
    public let activeBinId: Int
    public let binStep: Int
    public let bins: [PositionBin]

    public init(slot: Int, activeBinId: Int, binStep: Int, bins: [PositionBin]) {
        self.slot = slot
        self.activeBinId = activeBinId
        self.binStep = binStep
        self.bins = bins
    }
}

public struct WalletInfo: Codable, Identifiable, Sendable {
    public var id: String { address }
    public let address: String
    public let label: String
}

// Subset of the API /stats payload (extra keys are ignored by the decoder).
public struct Stats: Codable, Sendable {
    public let closedCount: Int
    public let winRate: Double
    public let totalPnlSol: Double
    public let todayPnlSol: Double
    public let totalFeesSol: Double
}

/// Engine health (subset). `wsConnected`/`meteoraOk` reflect the SERVER's data freshness —
/// distinct from the client's own socket, so the UI can warn when the engine is blind.
/// One external dependency's live status (rpc / meteora / jupiter / ws).
public struct SourceHealth: Codable, Sendable, Identifiable, Equatable {
    public var id: String { name }
    public let name: String
    public let status: String          // "ok" | "lagging" | "down"
    public let lastOkAt: Int?
    public let lastErrorAt: Int?
    public let consecutiveErrors: Int
    public let detail: String?
}

public struct Health: Codable, Sendable, Equatable {
    public let ok: Bool
    public let wsConnected: Bool
    public let meteoraOk: Bool
    // Added by the backend's per-source health system; optional so older payloads still decode.
    public let chainTipSlot: Int?
    public let sources: [SourceHealth]?
}

public struct LiveEvent: Codable, Sendable {
    public let id: String
    public let kind: String
    public let pair: String?
    public let title: String
    public let body: String
}

/// A notification rule (global when `wallet` is nil). Mirrors the API's NotifRule.
public struct NotifRule: Codable, Identifiable, Sendable {
    public var id: String { "\(wallet ?? "global"):\(eventKind)" }
    public let wallet: String?
    public let eventKind: String
    public var enabled: Bool
    public var mode: String
    public var threshold: Double?
    public var oorMinutes: Int?
}

/// Whether a raw frame is a periodic `state` snapshot — decided on the RAW text, before any decode.
///
/// That is the whole point: `state` is the 1 Hz firehose, and while the panel is closed the app only
/// needs it every few seconds to keep the menu bar honest. Every OTHER frame type (notify, event,
/// health, closed_changed) is rare and must never be dropped, so this deliberately answers "is it
/// safe to skip?" rather than "what type is it?" — anything it cannot recognise decodes as before.
public func isPeriodicStateFrame(_ text: String) -> Bool {
    // The server emits a compact, key-ordered envelope; tolerate leading whitespace only.
    text.drop(while: \.isWhitespace).hasPrefix(#"{"type":"state""#)
}

// Tagged server messages (discriminated union by `type`).
enum ServerMessage: Decodable {
    case state(WalletState)
    case event(LiveEvent)
    case notify(LiveEvent)
    case health(Health)
    case closedChanged
    case other

    private static let decoder = JSONDecoder()

    /// Decode a raw WS frame in ONE pass (was: decode an Envelope for `type`, THEN re-decode the same
    /// bytes into PayloadWrapper<T> with a freshly-allocated JSONDecoder per call — twice per 1Hz frame).
    init(from data: Data) throws {
        self = try ServerMessage.decoder.decode(ServerMessage.self, from: data)
    }

    private enum CodingKeys: String, CodingKey { case type, payload }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "state": self = .state(try c.decode(WalletState.self, forKey: .payload))
        case "event": self = .event(try c.decode(LiveEvent.self, forKey: .payload))
        case "notify": self = .notify(try c.decode(LiveEvent.self, forKey: .payload))
        case "health": self = .health(try c.decode(Health.self, forKey: .payload))
        case "closed_changed": self = .closedChanged
        default: self = .other
        }
    }
}
