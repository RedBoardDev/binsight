import Foundation

/// Client configuration (API endpoint). The API URL may be overridden in Settings or baked at
/// build time from the repo `.env` (Info.plist seed). Authentication is password→JWT (see `Auth`):
/// the password lives in the Keychain, never baked into the app.
public enum Config {
    static var defaults: UserDefaults { .standard }

    /// Non-empty Info.plist string baked at build time (the `BINSIGHT_API_URL` build setting, which
    /// `project.yml` maps to the `BinsightApiURL` key).
    private static func seed(_ key: String) -> String? {
        guard let s = Bundle.main.object(forInfoDictionaryKey: key) as? String, !s.isEmpty else {
            return nil
        }
        return s
    }

    public static var apiURL: String {
        get { defaults.string(forKey: "apiURL") ?? seed("BinsightApiURL") ?? "http://localhost:8787" }
        // Normalized on the way IN, so every reader is spared the question. Settings is not the only
        // writer, and a raw value here breaks every request the app makes.
        set { defaults.set(normalizedAPIURL(newValue), forKey: "apiURL") }
    }

    /// Production web origin — the live public site the panel's "open in browser" quick-link targets.
    public static let prodWebURL = "https://binsight.thomasott.fr"

    /// The web app origin for deep-links, mirroring the configured API origin.
    public static var webURL: String { webURL(fromAPI: apiURL) }

    /// Pure derivation (testable): the web origin is the API origin minus the `api.` host prefix
    /// (api.binsight.thomasott.fr → binsight.thomasott.fr). Non-`api.` hosts (e.g. a localhost dev API)
    /// fall back to the production web origin, since the quick-link always points at the live app.
    static func webURL(fromAPI apiURL: String) -> String {
        if let u = URL(string: apiURL), let scheme = u.scheme, let host = u.host, host.hasPrefix("api.") {
            return "\(scheme)://\(host.dropFirst(4))"
        }
        return prodWebURL
    }

    /// Master switch: when off, the app shows no native notifications (default on).
    public static var notificationsEnabled: Bool {
        get { defaults.object(forKey: "notificationsEnabled") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "notificationsEnabled") }
    }

    /// Whether the app has the minimum config to connect (a saved wallet address + password).
    public static var isConfigured: Bool {
        !(Keychain.get("authAddress") ?? "").isEmpty && !(Keychain.get("authPassword") ?? "").isEmpty
    }
}

/// Cleans up a hand-typed API base URL: trims surrounding whitespace and strips trailing slashes.
///
/// Every caller appends its own `"/path"`, so a stored `https://host/api/` produced
/// `https://host/api//auth/login`. That double slash is answered with a 308 redirect the client then
/// has to follow on a POST — a whole class of confusing failures for one stray character.
public func normalizedAPIURL(_ raw: String) -> String {
    var url = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    while url.count > 1, url.hasSuffix("/") { url.removeLast() }
    return url
}

/// True when the URL points at the web app's `/api` BFF rather than the API host itself.
///
/// Worth its own check because of HOW it fails: the BFF authenticates fine and puts the JWT in an
/// httpOnly cookie, returning only `{ok: true}`. A native client therefore gets a 200 with no token,
/// reports "unauthorized", and the server logs show a successful login — the most misleading state
/// this app can reach. Native clients want the dedicated API host.
public func looksLikeWebBFF(_ url: String) -> Bool {
    guard let components = URL(string: normalizedAPIURL(url)) else { return false }
    let path = components.path
    return path == "/api" || path.hasPrefix("/api/")
}

/// User-facing hint for a non-live connection state (nil when live/connecting normally).
public func connectionHint(_ state: ConnectionState, apiURL: String) -> String? {
    switch state {
    case .unconfigured: "Not signed in — open Settings to enter your wallet address + password."
    case .unauthorized: "Unauthorized — check your address and password in Settings."
    case .offline: "Can't reach the API at \(apiURL)."
    case .connecting, .live: nil
    }
}
