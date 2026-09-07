import SwiftUI

/// Shared "Connection" settings section (API URL + wallet address + password → JWT + error +
/// Save & reconnect). Used by the macOS Settings screen. `onSaved` lets the host
/// reconnect after a successful save. Renders a grouped `Section` — drop it
/// inside a `Form`. Sign-in only; creating an account / resetting a password is done on the web (they
/// require a wallet signature).
public struct ConnectionSettingsSection: View {
    private let onSaved: () -> Void
    @State private var apiURL = Config.apiURL
    @State private var address = Keychain.get("authAddress") ?? ""
    @State private var password = ""
    @State private var authError = false

    public init(onSaved: @escaping () -> Void) { self.onSaved = onSaved }

    private var addressValid: Bool { SolanaAddress.isValid(address) }

    public var body: some View {
        Section("Connection") {
            TextField("API URL", text: $apiURL).connectionInput()
            TextField("Wallet address", text: $address).connectionInput()
            SecureField("Password", text: $password)
            if !address.isEmpty && !addressValid {
                Text("That doesn't look like a Solana address.")
                    .font(.caption).foregroundStyle(Theme.loss)
            }
            if looksLikeWebBFF(apiURL) {
                // Caught BEFORE the save, because this failure is otherwise indistinguishable from
                // a wrong password: the BFF signs you in and keeps the token in a cookie.
                Text(
                    "That's the web app's /api proxy — it keeps the token in a cookie, "
                        + "so sign-in will appear to fail. Use the API host itself.",
                )
                .font(.caption).foregroundStyle(Theme.warn)
            }
            if authError {
                Text("Sign-in failed — wrong address/password or API unreachable.")
                    .font(.caption).foregroundStyle(Theme.loss)
            }
            Button("Save & reconnect") { save() }
                .buttonStyle(.glassProminent)
            Text("No account yet? Create one on the web with your wallet.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func save() {
        // Reflect the stored form back into the field, so the user sees what was actually kept
        // instead of silently diverging from it.
        apiURL = normalizedAPIURL(apiURL)
        Config.apiURL = apiURL
        Task { @MainActor in
            // An empty password keeps the saved credentials (e.g. when only the URL changed).
            if !password.isEmpty {
                let addr = address.trimmingCharacters(in: .whitespacesAndNewlines)
                guard addressValid, await Auth.shared.login(address: addr, password: password) else {
                    authError = true
                    return
                }
                password = ""
            }
            authError = false
            onSaved()
        }
    }
}

extension View {
    /// No autocorrect for URL-style fields.
    fileprivate func connectionInput() -> some View {
        autocorrectionDisabled()
    }
}
