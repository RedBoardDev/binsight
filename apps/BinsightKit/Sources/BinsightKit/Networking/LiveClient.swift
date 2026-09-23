import Foundation

public enum ClientDevice: String, Sendable { case mac, web }

/// @MainActor: the mutable connection state (socket/backoff/stopped/started/reconnecting/heartbeat)
/// is touched from URLSession completion handlers and Tasks. Pinning the whole class to the main
/// actor means every check-then-set guard (start's `started`, scheduleReconnect's `reconnecting`)
/// runs on one actor — no data race. The class is already created on the main actor and already
/// hopped to it for every store write.
@MainActor
public final class LiveClient {
    private let store: PortfolioStore
    private let device: ClientDevice
    public var onSync: (() -> Void)?
    private var task: URLSessionWebSocketTask?
    private var backoff: UInt64 = 1
    private var stopped = false
    private var started = false
    private var heartbeat: Task<Void, Never>?
    private var reconnecting = false
    /// The pending backoff sleep → `connect()`. Kept so `stop()` can cancel it: a sleeper that only
    /// checked `stopped` woke after a `stop(); start()` and opened a SECOND socket.
    private var reconnectTask: Task<Void, Never>?
    /// Bumped every time the current socket is dropped (`stop()`, `scheduleReconnect()`). Callbacks and
    /// in-flight connects capture it and bail on a mismatch, so a late failure from a socket we already
    /// replaced can't tear down — or double — the one that replaced it.
    private var generation = 0
    /// When the last periodic `state` frame was actually processed. See `shouldSkipStateFrame`.
    private var lastStateAppliedAt: Date?
    /// Whether macOS lets this app show banners. The OS answers asynchronously, so it is cached here
    /// for the synchronous presence frame and re-read on every heartbeat — a change in System Settings
    /// lands within one tick. Starts false: never claim presence before we know.
    private var notificationsAuthorized = false

    /// Whether this device counts as "present" right now. The host platform injects the real
    /// logic (macOS: not idle/asleep/locked). Default: always present.
    public var presenceActive: () -> Bool = { true }

    public init(store: PortfolioStore, device: ClientDevice) {
        self.store = store
        self.device = device
    }

    /// Called once at launch. Idempotent: a second call while started does nothing.
    public func start() {
        if started { return }
        started = true
        stopped = false
        backoff = 1
        connect()
    }

    public func stop() {
        started = false
        stopped = true
        generation += 1
        heartbeat?.cancel()
        heartbeat = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnecting = false
        backoff = 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    /// Explicit, user-initiated reconnect (Settings saved, the Reconnect button): drop the socket and
    /// connect afresh — and let credentials the server refused be tried once more, since the API URL
    /// may be what changed.
    public func restart() {
        stop()
        started = true
        stopped = false
        connect(clearingRejection: true)
    }

    /// Send a presence update immediately (call on sleep/wake/lock/foreground transitions, or when
    /// the notification toggle / permission changed). Sent at once from the cached permission — a
    /// sleep can't wait on the OS — then again if re-reading the permission changed it.
    public func refreshPresence() {
        sendPresence()
        Task { [weak self] in
            guard let self, await self.refreshNotificationAuthorization() else { return }
            self.sendPresence()
        }
    }

    /// Re-reads the OS notification permission. True when it changed.
    private func refreshNotificationAuthorization() async -> Bool {
        let authorized = await NotifPermission.showsBanners()
        guard authorized != notificationsAuthorized else { return false }
        notificationsAuthorized = authorized
        return true
    }

    /// Force a fresh connection now. Call on wake / return-to-foreground: the old socket is
    /// stale (URLSession won't report it), so we drop it and reconnect rather than guess.
    public func reconnect() {
        guard started, !stopped else { return }
        // A refused password stays refused across a sleep: only new credentials or `restart()` retry.
        if store.connection == .unauthorized, task == nil { return }
        // Wake beats a pending backoff: don't sit out the rest of a 15 s sleep before retrying.
        reconnectTask?.cancel()
        reconnecting = false
        backoff = 1
        scheduleReconnect()
    }

    public func setScope(_ scope: String) {
        store.scope = scope // set synchronously so applied states match (no race)
        store.resetClosedPaging() // another wallet's history starts at page 1, not the old depth
        subscribe(scope)
        onSync?()
    }

    /// Back to the all-wallets scope once the scoped wallet has left the watchlist. The server stops
    /// streaming a wallet it no longer watches, so a stale scope would drop every frame
    /// (`PortfolioStore.apply`) and freeze the panel on its last numbers.
    public func dropScopeIfUnwatched() {
        guard !store.isScopeWatched else { return }
        setScope("all")
    }

    private func subscribe(_ scope: String) {
        send(#"{"type":"subscribe","scope":"\#(scope)"}"#)
    }

    private func wsURL() -> URL? {
        // Anchor the scheme swap to the PREFIX — a blanket http→ws replace would corrupt any host/path
        // that contains "http" into an unconnectable URL.
        let api = Config.apiURL
        let base: String
        if api.hasPrefix("https") {
            base = "wss" + api.dropFirst("https".count)
        } else if api.hasPrefix("http") {
            base = "ws" + api.dropFirst("http".count)
        } else {
            base = api
        }
        return URL(string: "\(base)/live")
    }

    private func connect(clearingRejection: Bool = false) {
        reconnecting = false
        guard Config.isConfigured else {
            store.setConnection(.unconfigured)
            return // no password yet — wait for Settings → reconnect rather than failing in a loop
        }
        store.setConnection(.connecting)
        let gen = generation
        // Fetch a fresh JWT (re-logins from the stored password if needed) before opening the socket.
        Task { [weak self] in
            guard let self else { return }
            if clearingRejection { await Auth.shared.clearRejection() }
            let auth = await Auth.shared.tokenResult()
            // Re-check AFTER the await: stop() or a heartbeat-triggered scheduleReconnect() may have
            // landed while we fetched the token. Opening a socket now would leak it (a parallel reconnect
            // owns the connection) — bail and let that path drive.
            if self.stopped || self.reconnecting || gen != self.generation { return }
            let token: String
            switch auth {
            case .token(let t):
                token = t
            case .rejected:
                // Terminal until the credentials change: no retry timer (which would also overwrite
                // this with `.offline`). Settings' save, or an explicit reconnect, restarts us.
                self.store.setConnection(.unauthorized)
                return
            case .unreachable:
                self.scheduleReconnect() // → .offline, retried with backoff
                return
            }
            guard let url = self.wsURL() else {
                self.scheduleReconnect()
                return
            }
            // Send the JWT in the Authorization header, not the URL query — a long-lived token in the
            // upgrade URL would persist in nginx/proxy access logs (S10). URLSessionWebSocketTask carries
            // the URLRequest's headers on the HTTP upgrade.
            var request = URLRequest(url: url)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let t = URLSession.shared.webSocketTask(with: request)
            self.task = t
            t.resume()
            self.sendPresence()
            // Re-assert our scope on every (re)connect — the server defaults new connections to
            // "all", so without this a wallet-scoped client would receive (and reject) "all" states.
            self.subscribe(self.store.scope)
            self.startHeartbeat()
            self.receive()
            self.onSync?() // pull closed history + stats over REST on (re)connect
        }
    }

    private func receive() {
        let gen = generation
        task?.receive { [weak self] result in
            Task { @MainActor in
                // A replaced socket's late frame or failure must not touch the current connection.
                guard let self, gen == self.generation else { return }
                switch result {
                case .success(let message):
                    self.store.setConnection(.live)
                    self.backoff = 1
                    if case .string(let text) = message {
                        // Drain the socket either way, but only pay for the frame when someone is
                        // going to see it: skipping the UTF-8 copy, the decode and the store write is
                        // the difference between processing ~1 frame a second forever and processing
                        // one every few seconds while the panel is shut.
                        if !self.shouldSkipStateFrame(text),
                            let data = text.data(using: .utf8)
                        {
                            self.handle(data)
                        }
                    }
                    self.receive()
                case .failure:
                    self.scheduleReconnect()
                }
            }
        }
    }

    /// Whether this raw frame can be dropped without the user ever knowing.
    ///
    /// True only for a periodic `state` snapshot, only while the panel is closed, and only inside the
    /// window the menu bar is throttled to anyway — so the readout stays as fresh as it is allowed to
    /// render. Every other frame type passes through untouched: a `notify` must never be dropped, and
    /// `event` / `closed_changed` / `health` are rare by nature.
    private func shouldSkipStateFrame(_ text: String, now: Date = Date()) -> Bool {
        guard !store.panelVisible, isPeriodicStateFrame(text) else { return false }
        guard let last = lastStateAppliedAt else { return false }
        return now.timeIntervalSince(last) < menuBarThrottleSeconds
    }

    private func handle(_ data: Data) {
        let msg: ServerMessage
        do {
            msg = try ServerMessage(from: data)
        } catch {
            // Don't silently swallow a decode failure: the socket stays .live but the numbers would
            // freeze (a renamed/null backend field drops the whole non-optional state message). Log it
            // so the schema drift is diagnosable instead of an invisible freeze.
            NSLog("[LiveClient] failed to decode server message: %@", String(describing: error))
            return
        }
        switch msg {
        case .state(let state):
            // Stamp only a frame the store will actually take: an other-scope frame is dropped, and
            // counting it would let the skip window starve the menu bar of the real one.
            if state.scope == store.scope { lastStateAppliedAt = Date() }
            store.apply(state)
        case .event:
            onSync?() // raw live feed: a transition (e.g. close) changes history → refresh, no banner
        case .notify(let event):
            // Rule-gated by the backend (disabled rules never reach here) → safe to show.
            if Config.notificationsEnabled { Notifier.show(event) }
        case .closedChanged:
            onSync?() // a close was just persisted → refresh history, no banner (the alert comes later)
        case .health(let h): store.setHealth(h)
        case .other: break
        }
    }

    /// A socket callback reported a failure: reconnect — unless that socket was already replaced.
    private func socketFailed(generation gen: Int) {
        guard gen == generation else { return }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !reconnecting, !stopped else { return }
        reconnecting = true
        generation += 1 // every callback of the socket being dropped is stale from here on
        heartbeat?.cancel()
        let unauthorized = task?.closeCode == .policyViolation // server closed /live with 1008
        task?.cancel(with: .goingAway, reason: nil) // drop the stale/half-dead socket
        task = nil
        // A rejected token may just be expired — drop the cache so the next connect re-logins.
        if unauthorized { Task { await Auth.shared.invalidate() } }
        store.setConnection(unauthorized ? .unauthorized : .offline)
        let delay = backoff
        backoff = min(backoff * 2, 15)
        let gen = generation
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            // A cancelled sleep returns early (the error is swallowed), so check for it explicitly.
            guard !Task.isCancelled, let self, !self.stopped, gen == self.generation else { return }
            self.reconnectTask = nil
            self.connect()
        }
    }

    private func startHeartbeat() {
        heartbeat?.cancel()
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                _ = await self?.refreshNotificationAuthorization()
                self?.sendPresence()
                self?.ping() // detect a dead/half-open socket (e.g. after sleep) → reconnect
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    /// Liveness probe: a failed pong means the socket is dead even if `receive` never errored
    /// (happens after the Mac sleeps — URLSession leaves the task hanging silently).
    private func ping() {
        let gen = generation
        task?.sendPing { [weak self] error in
            if error != nil { Task { @MainActor in self?.socketFailed(generation: gen) } }
        }
    }

    private func sendPresence() {
        // Report active only when we'll actually SHOW a native banner: present (foreground/awake),
        // notifications enabled here AND allowed by macOS. Otherwise the server would route "native"
        // to us and skip Bark — a muted or unpermitted device would swallow the alert (black hole).
        // Reporting inactive lets routing fall through to another open app, or to Bark on the phone.
        let active = presenceActive() && Config.notificationsEnabled && notificationsAuthorized
        send(#"{"type":"presence","device":"\#(device.rawValue)","active":\#(active)}"#)
    }

    /// Send a control frame; if the socket is broken the send fails → drop it and reconnect
    /// rather than silently losing the subscribe/presence and stalling on a dead connection.
    private func send(_ json: String) {
        guard let task else { return }
        let gen = generation
        task.send(.string(json)) { [weak self] error in
            if error != nil { Task { @MainActor in self?.socketFailed(generation: gen) } }
        }
    }
}
