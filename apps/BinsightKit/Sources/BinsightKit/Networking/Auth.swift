import Foundation
import OSLog

/// Auth is the one path whose failure is invisible in the UI (it can only report "unauthorized"), so
/// it logs the *reason*. Diagnosing a sign-in that the server answers with 200 while the app says
/// unauthorized is otherwise guesswork. Never logs credentials — status codes and the endpoint only.
private let authLog = Logger(subsystem: "com.binsight", category: "auth")

/// What asking for a token came to. The live client needs the difference: a refused password must
/// show "unauthorized" and wait for new credentials, an unreachable API must show "offline" and retry.
public enum TokenResult: Sendable, Equatable {
    case token(String)
    /// The server refused the stored credentials, or none are stored. Retrying cannot help.
    case rejected
    /// No usable answer (transport failure, rate limit, 5xx). Worth retrying later.
    case unreachable
}

/// Wallet-address + password → JWT auth. The account identity is the Solana wallet address; both the
/// address and password are stored in the Keychain, and a short-lived JWT is fetched from `/auth/login`
/// and cached (refreshed before expiry, or after a 401). The REST + WS clients use the JWT as a Bearer
/// token. There is no static API token. Registration / password reset are web-only (they need the
/// wallet to sign) — the app only signs in.
public actor Auth {
    public static let shared = Auth()

    private struct LoginResponse: Decodable {
        let token: String
        let expiresInSeconds: Int
    }

    private enum LoginOutcome {
        case ok(LoginResponse)
        case rejected
        case unreachable
    }

    private var cachedToken: String?
    private var expiresAt: Date?
    /// In-flight refresh, shared so concurrent callers (a cold reconnect fires several at once) await ONE
    /// /auth/login instead of each firing its own.
    private var refreshTask: Task<TokenResult, Never>?
    /// Fingerprint of the stored credentials the server last refused (a per-process `Hasher` value, so
    /// the password itself is never held). While the Keychain still holds exactly those, `refresh()`
    /// answers `.rejected` without sending them again: a reconnect timer re-posting a refused password
    /// every few seconds can never succeed, and reads like a guessing attack to the server.
    private var rejectedCredentials: Int?

    /// A currently-valid JWT, refreshed from the stored password when needed. Nil if not logged in.
    public func token() async -> String? {
        if case .token(let t) = await tokenResult() { return t }
        return nil
    }

    /// Like `token()`, but says WHY there is none.
    public func tokenResult() async -> TokenResult {
        if let t = cachedToken, let e = expiresAt, e > Date().addingTimeInterval(60) { return .token(t) }
        if let inflight = refreshTask { return await inflight.value } // coalesce concurrent refreshes
        let task = Task { await refresh() }
        refreshTask = task
        defer { refreshTask = nil }
        return await task.value
    }

    /// Exchange an address + password for a JWT and persist both on success. The session they replace
    /// is revoked on the server (best effort, in the background) so it can't be replayed within its TTL.
    @discardableResult
    public func login(address: String, password: String) async -> Bool {
        guard case .ok(let res) = await fetch(address: address, password: password) else { return false }
        Keychain.set("authAddress", address)
        Keychain.set("authPassword", password)
        let replaced = cachedToken
        apply(res)
        rejectedCredentials = nil
        if let replaced, replaced != res.token {
            Task { await postLogout(token: replaced) }
        }
        return true
    }

    /// Forget the credentials and any cached token, and revoke the backend session (so the JWT can't
    /// be replayed within its TTL). The revocation is best effort and runs in the background: the
    /// local sign-out is done when this returns, even if the server is unreachable.
    public func logout() {
        let revoked = cachedToken
        Keychain.set("authAddress", "")
        Keychain.set("authPassword", "")
        cachedToken = nil
        expiresAt = nil
        rejectedCredentials = nil
        if let revoked {
            Task { await postLogout(token: revoked) }
        }
    }

    private func postLogout(token: String) async {
        guard let url = URL(string: Config.apiURL + "/auth/logout") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        _ = try? await URLSession.shared.data(for: req)
    }

    /// Drop the cached token so the next `token()` re-logins (call after a 401).
    public func invalidate() {
        cachedToken = nil
        expiresAt = nil
    }

    /// Let the stored credentials be tried again. For an explicit, user-initiated reconnect only (e.g.
    /// the API URL changed while the password stayed) — never for a timer.
    public func clearRejection() {
        rejectedCredentials = nil
    }

    private func refresh() async -> TokenResult {
        guard let addr = Keychain.get("authAddress"), !addr.isEmpty,
            let pw = Keychain.get("authPassword"), !pw.isEmpty
        else { return .rejected }
        let fingerprint = Self.fingerprint(addr, pw)
        if rejectedCredentials == fingerprint { return .rejected }
        switch await fetch(address: addr, password: pw) {
        case .ok(let res):
            apply(res)
            return .token(res.token)
        case .rejected:
            rejectedCredentials = fingerprint
            return .rejected
        case .unreachable:
            return .unreachable
        }
    }

    private static func fingerprint(_ address: String, _ password: String) -> Int {
        var h = Hasher()
        h.combine(address)
        h.combine(password)
        return h.finalize()
    }

    private func apply(_ res: LoginResponse) {
        cachedToken = res.token
        expiresAt = Date().addingTimeInterval(TimeInterval(res.expiresInSeconds))
    }

    private func fetch(address: String, password: String) async -> LoginOutcome {
        let endpoint = Config.apiURL + "/auth/login"
        guard let url = URL(string: endpoint) else {
            authLog.error("login: malformed API URL \(endpoint, privacy: .public)")
            return .unreachable
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(
            withJSONObject: ["address": address, "password": password])

        let response: (Data, URLResponse)
        do {
            response = try await URLSession.shared.data(for: req)
        } catch {
            authLog.error("login: transport failure — \(error.localizedDescription, privacy: .public)")
            return .unreachable
        }
        let status = (response.1 as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            authLog.error("login: HTTP \(status, privacy: .public) from \(endpoint, privacy: .public)")
            // 400 (malformed address/password), 401 (wrong pair) and 403 are the server's verdict on
            // these credentials. Anything else — 429, a 5xx, a proxy's 404 — says nothing about them.
            return [400, 401, 403].contains(status) ? .rejected : .unreachable
        }
        guard let decoded = try? JSONDecoder().decode(LoginResponse.self, from: response.0) else {
            // The web `/api` BFF lands exactly here: 200, but the token went into a cookie and the
            // body is `{ok:true}`. Name it, because the symptom looks like bad credentials — and it is
            // treated as one: re-posting the password to the same URL can never yield a token.
            authLog.error(
                "login: 200 without a usable token — is the API URL the web /api proxy? \(endpoint, privacy: .public)",
            )
            return .rejected
        }
        return .ok(decoded)
    }
}
