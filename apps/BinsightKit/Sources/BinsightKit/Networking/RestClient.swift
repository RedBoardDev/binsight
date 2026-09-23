import Foundation

/// One REST page of closed history: the initial depth, and the step each "Load more" adds.
public let closedPageSize = 20
/// Ceiling the API clamps `pageSize` to (see `routes.ts`). A resync of a deeper history is capped
/// here rather than silently coming back truncated.
let closedPageSizeMax = 100

/// @MainActor for the same reason as `LiveClient`: every read and write this type makes lands on the
/// store, which is main-actor isolated. Pinning the client there removes the hop-per-field dance the
/// bodies below used to need, and lets the compiler prove the scope guards actually hold.
@MainActor
public final class RestClient {
    private let store: PortfolioStore

    /// Whether the panel is on screen.
    ///
    /// Everything `load()` fetches — closed history, stats, wallets — is invisible while the panel is
    /// closed, which is nearly always. The menu bar and the notifications both ride the socket
    /// instead. So a close landing overnight used to fire a three-request REST round trip, decode it
    /// and write it into the store for nobody to see; now it just raises `refreshPending`.
    private var panelVisible = false
    /// A resync was asked for while hidden, or while one was already running. Collapses any number of
    /// requests into the single one that will actually be displayed.
    private var refreshPending = false
    private var loading = false
    /// Called after a resync replaced `store.wallets` — the host drops a scope whose wallet is gone
    /// (see `LiveClient.dropScopeIfUnwatched`).
    public var onWalletsLoaded: (() -> Void)?

    public init(store: PortfolioStore) { self.store = store }

    /// Call when the panel comes on screen: flushes a deferred resync, so the first thing the user
    /// sees is fresh.
    public func panelDidAppear() {
        panelVisible = true
        if refreshPending { refresh() }
    }

    public func panelDidDisappear() {
        panelVisible = false
        store.trimClosedToFirstPage() // don't hold a deep scroll between glances
    }

    public func refresh() {
        // Deferred while hidden, and coalesced while a load is in flight: `.event` and
        // `.closedChanged` both fire for a single position close, which used to mean two full
        // refreshes for one event.
        guard panelVisible, !loading else {
            refreshPending = true
            return
        }
        refreshPending = false
        Task { await load() }
    }

    private func load() async {
        loading = true
        defer {
            loading = false
            // A request that arrived mid-flight gets exactly one replay, not one per arrival.
            if refreshPending, panelVisible { refresh() }
        }
        let scope = store.scope
        let pages = store.closedPage
        // Resync the depth the user had already loaded — ONE request for pages 1…n rather than n
        // requests, so a "load more" isn't undone by the next close event's refresh.
        let depth = min(closedPageSizeMax, closedPageSize * pages)
        async let pageT: ClosedPage? = Backend.get(
            "/positions/closed?wallet=\(scope)&page=1&pageSize=\(depth)")
        async let statsT: Stats? = Backend.get("/stats?wallet=\(scope)")
        async let walletsT: [WalletInfo]? = Backend.get("/wallets")
        let (page, stats, wallets) = await (pageT, statsT, walletsT)
        // A scope switch mid-flight must not get overwritten with the old scope's data: bail if the
        // store's scope changed while these three fetches were in flight.
        guard store.scope == scope else { return }
        if let page {
            store.replaceClosed(page.rows, total: page.total, pages: pages)
        }
        if let stats { store.stats = stats }
        if let wallets {
            store.wallets = wallets
            onWalletsLoaded?() // may switch the scope, which queues a resync the defer replays
        }
        store.pruneBins() // resync is event-driven — a good, rare moment to drop closed positions
    }

    /// Append the next page of closed history. No-op while a page is already in flight, or once the
    /// whole history is loaded.
    public func loadMoreClosed() {
        Task { await loadMore() }
    }

    private func loadMore() async {
        guard !store.loadingMoreClosed, store.hasMoreClosed else { return }
        store.loadingMoreClosed = true
        let scope = store.scope
        let page = store.closedPage + 1
        let fetched: ClosedPage? = await Backend.get(
            "/positions/closed?wallet=\(scope)&page=\(page)&pageSize=\(closedPageSize)")
        store.loadingMoreClosed = false
        // Same guard as `load()`: a scope switch mid-flight must not append another wallet's rows.
        guard store.scope == scope, let fetched else { return }
        store.appendClosed(fetched.rows, total: fetched.total, page: page)
    }

    /// Fetch ONE open position's per-bin liquidity for its card chart. Each call costs ~2 RPC reads
    /// server-side (position header, then the pair + bin arrays in one multi-account read), so the
    /// store's TTL/in-flight claim — not the caller — decides whether a request actually goes out.
    public func loadBins(for address: String) {
        Task { await fetchBins(address) }
    }

    private func fetchBins(_ address: String) async {
        guard store.claimBinsFetch(address) else { return }
        let encoded =
            address.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? address
        let snapshot: PositionBins? = await Backend.get("/positions/\(encoded)/bins")
        store.releaseBinsFetch(address)
        if let snapshot { store.setBins(snapshot, for: address) }
    }
}
