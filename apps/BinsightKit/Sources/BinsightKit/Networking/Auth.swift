import Foundation
import OSLog

/// Auth is the one path whose failure is invisible in the UI (it can only report "unauthorized"), so
/// it logs the *reason*. Diagnosing a sign-in that the server answers with 200 while the app says
/// unauthorized is otherwise guesswork. Never logs credentials — status codes and the endpoint only.
private let authLog = Logger(subsystem: "com.binsight", category: "auth")

/// Wallet-address + password → JWT auth. The account identity is the Solana wallet address; both the
/// address and password are stored in the Keychain, and a short-lived JWT is fetched from `/auth/login`
/// and cached (refreshed before expiry, or after a 401). The REST + WS clients use the JWT as a Bearer
/// token / `?token=`. There is no static API token. Registration / password reset are web-only (they
/// need the wallet to sign) — the Apple apps only sign in.
public actor Auth {
    public static let shared = Auth()

    private struct LoginResponse: Decodable {
        let token: String
        let expiresInSeconds: Int
    }

    private var cachedToken: String?
    private var expiresAt: Date?
    /// In-flight refresh, shared so concurrent callers (a cold reconnect fires several at once) await ONE
    /// /auth/login instead of each firing its own.
    private var refreshTask: Task<String?, Never>?

    /// A currently-valid JWT, refreshed from the stored password when needed. Nil if not logged in.
    public func token() async -> String? {
        if let t = cachedToken, let e = expiresAt, e > Date().addingTimeInterval(60) { return t }
        if let inflight = refreshTask { return await inflight.value } // coalesce concurrent refreshes
        let task = Task { await refresh() }
        refreshTask = task
        defer { refreshTask = nil }
        return await task.value
    }

    /// Exchange an address + password for a JWT and persist both on success.
    @discardableResult
    public func login(address: String, password: String) async -> Bool {
        guard let res = await fetch(address: address, password: password) else { return false }
        Keychain.set("authAddress", address)
        Keychain.set("authPassword", password)
        apply(res)
        return true
    }

    /// Revoke the backend session (so the JWT can't be replayed within its TTL), then forget the
    /// credentials and any cached token. Best-effort on the network call — the local credentials are
    /// always cleared even if the server is unreachable.
    public func logout() async {
        if let t = cachedToken { await postLogout(token: t) }
        Keychain.set("authAddress", "")
        Keychain.set("authPassword", "")
        cachedToken = nil
        expiresAt = nil
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

    private func refresh() async -> String? {
        guard let addr = Keychain.get("authAddress"), !addr.isEmpty,
            let pw = Keychain.get("authPassword"), !pw.isEmpty
        else { return nil }
        guard let res = await fetch(address: addr, password: pw) else { return nil }
        apply(res)
        return cachedToken
    }

    private func apply(_ res: LoginResponse) {
        cachedToken = res.token
        expiresAt = Date().addingTimeInterval(TimeInterval(res.expiresInSeconds))
    }

    private func fetch(address: String, password: String) async -> LoginResponse? {
        let endpoint = Config.apiURL + "/auth/login"
        guard let url = URL(string: endpoint) else {
            authLog.error("login: malformed API URL \(endpoint, privacy: .public)")
            return nil
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
            return nil
        }
        let status = (response.1 as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            authLog.error("login: HTTP \(status, privacy: .public) from \(endpoint, privacy: .public)")
            return nil
        }
        guard let decoded = try? JSONDecoder().decode(LoginResponse.self, from: response.0) else {
            // The web `/api` BFF lands exactly here: 200, but the token went into a cookie and the
            // body is `{ok:true}`. Name it, because the symptom looks like bad credentials.
            authLog.error(
                "login: 200 without a usable token — is the API URL the web /api proxy? \(endpoint, privacy: .public)",
            )
            return nil
        }
        return decoded
    }
}
