import Foundation
import Observation

/// Ceiling on how deep auto-pagination will walk the closed history.
///
/// The history is effectively unbounded — 18k+ rows on a busy wallet — and scrolling auto-loads the
/// next page forever. Retaining all of it for the lifetime of a process that runs for weeks is the
/// one place this app can grow without limit. 25 pages is far more than anyone scrolls in a 220pt
/// list, and the full history lives on the web app. Note this bounds LOADING; it never removes rows
/// from under the user, which is why the cap is expressed here and not as a trim.
public let closedRetentionCap = 500

/// How long a fetched bin snapshot stays fresh. Each refetch costs ~2 server-side RPC reads for that
/// position, so the panel reuses a snapshot for a minute rather than re-reading on every open.
public let binsTTLSeconds: TimeInterval = 60

public enum ConnectionState: Sendable, Equatable {
    case unconfigured // no auth password set yet
    case connecting
    case live
    case offline // can't reach the API
    case unauthorized // API rejected the credentials (WS 1008)
}

@Observable
@MainActor
public final class PortfolioStore {
    public var scope: String = "all"
    public var wallets: [WalletInfo] = []
    public var totals: PortfolioTotals?
    public var positions: [OpenPosition] = []
    public var closed: [ClosedPosition] = []
    public var closedTotal = 0
    /// How many REST pages of closed history are currently loaded (see `closedPageSize`). Drives the
    /// panel's "Load more" and lets a resync restore the SAME depth instead of snapping back to a
    /// single page under the user.
    public private(set) var closedPage = 1
    /// A "load more" fetch is in flight — guards against a double tap queueing the same page twice.
    public var loadingMoreClosed = false
    /// Per-position bin snapshots for the open cards' chart, keyed by position address. Fetched on
    /// demand and reused for `binsTTLSeconds`: each read costs server-side RPC, so this is never
    /// driven off the 1 Hz state tick.
    public private(set) var bins: [String: PositionBins] = [:]
    private var binsAge: [String: Date] = [:]
    private var binsInFlight: Set<String> = []
    public var stats: Stats?
    public var connection: ConnectionState = .connecting
    public var health: Health?
    /// The menu bar's rendered content, republished only when it actually differs. The single piece of
    /// state a closed panel still observes — see `MenuBarSnapshot`.
    public private(set) var menuBar = MenuBarSnapshot(text: "—", tone: .neutral)
    private var menuBarPublishedAt: Date?
    /// Whether the panel is on screen. `@ObservationIgnored` on purpose: it steers how much work the
    /// clients do, and must not itself become a source of view invalidation.
    @ObservationIgnored public var panelVisible = false

    public init() {}

    /// Whether `scope` still names something the server streams: the aggregate, or a wallet still in
    /// the watchlist. A removed wallet gets no more frames, and a subscribe to it is ignored.
    public var isScopeWatched: Bool {
        scope == "all" || wallets.contains { $0.address == scope }
    }

    // Both setters are called from the socket's receive loop, i.e. once a second — and both were
    // writing unconditionally. `setConnection(.live)` in particular re-published an already-`.live`
    // value on every single frame. Same rule as `apply`: no write, no invalidation.
    public func setHealth(_ h: Health) {
        if health != h { health = h }
    }

    /// Apply a freshly-fetched prefix of the closed history.
    ///
    /// A resync can return FEWER rows than are on screen: the fetch depth is capped by the API's
    /// `pageSize` limit, so anyone who scrolled past that cap has more loaded than one request can
    /// bring back. Replacing outright would truncate the list under them — with 18k closed positions
    /// that is a very reachable state — so fresh rows overwrite the prefix and deeper rows are kept.
    public func replaceClosed(_ rows: [ClosedPosition], total: Int, pages: Int) {
        if rows.count < closed.count {
            let fresh = Set(rows.map(\.positionAddress))
            let retainedTail = closed.dropFirst(rows.count).filter {
                !fresh.contains($0.positionAddress)
            }
            closed = rows + retainedTail
        } else {
            closed = rows
        }
        closedTotal = total
        closedPage = max(1, pages)
    }

    /// Append the next closed page, dropping rows already on screen. A close landing between two page
    /// fetches shifts the offset window, which would otherwise repeat a row — and a duplicate id
    /// breaks `ForEach`.
    public func appendClosed(_ rows: [ClosedPosition], total: Int, page: Int) {
        let known = Set(closed.map(\.positionAddress))
        closed.append(contentsOf: rows.filter { !known.contains($0.positionAddress) })
        closedTotal = total
        closedPage = max(closedPage, page)
    }

    /// Back to a single page — a scope switch shows another wallet's history from the top.
    public func resetClosedPaging() { closedPage = 1 }

    /// Whether more closed rows are worth loading: the server has more AND we are still under the
    /// retention cap. Both halves matter — the first ends pagination on a short history, the second
    /// keeps a long one from growing unbounded.
    public var hasMoreClosed: Bool {
        closed.count < closedTotal && closed.count < closedRetentionCap
    }

    /// True when pagination stopped because of the cap rather than because the history ran out — the
    /// panel says so, instead of just going quiet as though there were nothing left.
    public var closedTruncatedByCap: Bool {
        closed.count >= closedRetentionCap && closed.count < closedTotal
    }

    /// Release the deep history when the panel closes.
    ///
    /// The list is rebuilt from the top on the next open anyway, so holding 25 pages of rows between
    /// two glances is pure residency for a process that lives for weeks. Resetting the page counter
    /// with them also keeps the next resync's fetch depth honest.
    public func trimClosedToFirstPage() {
        guard closed.count > closedPageSize else { return }
        closed = Array(closed.prefix(closedPageSize))
        closedPage = 1
    }

    public func setBins(_ snapshot: PositionBins, for address: String, now: Date = Date()) {
        bins[address] = snapshot
        binsAge[address] = now
    }

    /// True when `address` has no snapshot yet, or its snapshot aged past the TTL. The single gate in
    /// front of every bin fetch — the panel re-asks on each open, and this is what keeps that cheap.
    public func binsAreStale(_ address: String, now: Date = Date()) -> Bool {
        guard let at = binsAge[address] else { return true }
        return now.timeIntervalSince(at) >= binsTTLSeconds
    }

    /// Claims the bin fetch for `address`: true only when the caller should really hit the network —
    /// nothing fresh cached AND no fetch already running for it. Without the in-flight half, a card
    /// remount (panel reopened mid-request) would fire a second identical RPC-backed read.
    public func claimBinsFetch(_ address: String, now: Date = Date()) -> Bool {
        guard binsAreStale(address, now: now), !binsInFlight.contains(address) else { return false }
        binsInFlight.insert(address)
        return true
    }

    /// Releases the claim. Must run on every outcome, so a failed read is retried on the next open
    /// instead of being locked out for the rest of the session.
    public func releaseBinsFetch(_ address: String) { binsInFlight.remove(address) }

    public func apply(_ state: WalletState) {
        guard state.scope == scope else { return } // ignore other scopes' snapshots
        // Assign ONLY on a real change. Under @Observable every write invalidates its observers, and
        // this runs at 1 Hz for the life of the process: an idle portfolio was re-rendering the menu
        // bar ~86_400 times a day to display identical numbers. `lastTickAt` used to be written here
        // too — read by nobody, so it was pure invalidation and is gone.
        if totals != state.totals { totals = state.totals }
        let ranked = state.openPositions.sorted { $0.pnlSol > $1.pnlSol }
        if positions != ranked { positions = ranked }
        refreshMenuBar()
    }

    public func setConnection(_ c: ConnectionState) {
        if connection != c { connection = c }
        refreshMenuBar()
    }

    /// Recompute the menu bar's content and publish it ONLY on a real difference. Both callers run on
    /// the 1 Hz socket path, so this guard is what stands between a resting app and 86_400 renders a
    /// day of an unchanged label.
    private func refreshMenuBar(now: Date = Date()) {
        let next = menuBarSnapshot(connection: connection, totals: totals)
        guard menuBar != next else { return }
        // A digit drifting waits for the throttle window; anything the user should see at once does
        // not. `now` is injectable so the cadence is testable without waiting on a clock.
        if !next.differsStructurally(from: menuBar), let last = menuBarPublishedAt,
            now.timeIntervalSince(last) < menuBarThrottleSeconds
        {
            return
        }
        menuBar = next
        menuBarPublishedAt = now
    }

    /// Test seam for the throttle: applies a frame as if it arrived at `now`.
    func applyForTesting(_ state: WalletState, now: Date) {
        guard state.scope == scope else { return }
        if totals != state.totals { totals = state.totals }
        let ranked = state.openPositions.sorted { $0.pnlSol > $1.pnlSol }
        if positions != ranked { positions = ranked }
        refreshMenuBar(now: now)
    }

    /// Drop bin snapshots for positions that are no longer open, so the cache can't grow unbounded
    /// over a long-running session (one entry per position ever seen).
    public func pruneBins() {
        let live = Set(positions.map(\.positionAddress))
        bins = bins.filter { live.contains($0.key) }
        binsAge = binsAge.filter { live.contains($0.key) }
    }
}
