# Binsight — macOS menu-bar app

SwiftUI menu-bar client for the Binsight API. The mobile experience now lives in the web **PWA**;
this app is the always-on desktop glance (menu-bar agent).

## Structure

```
apps/
  BinsightKit/      shared Swift package (macOS-only; AppKit is fine — see note below)
    Sources/BinsightKit/{Models,Networking,State,Notifications,Formatting,UI}
    Tests/BinsightKitTests
  BinsightMac/      macOS menu-bar app (MenuBarExtra) — thin shell
  project.yml       XcodeGen: the package + the macOS app target
```

`BinsightKit` holds the reusable core (wire types, WS/REST clients, store, notifier, formatters,
shared SwiftUI components); `BinsightMac` owns only the menu-bar presentation shell. The kit is
**macOS-only** (the web PWA covers mobile), so it freely uses AppKit (`NSWorkspace`, `NSColor`) where
convenient; there is no "no-AppKit / portable" constraint.

## Install (from the repo root)

```sh
make install-mac    # build + install to /Applications, then launch
```

Helpers: `make xcode` (open the project), `make apps-gen` (regenerate `Binsight.xcodeproj`),
`make apps-test` (run the BinsightKit unit tests). First run installs XcodeGen via Homebrew.

### Zero config: the API URL is baked from `.env`

`make install-mac` reads `CLIENT_API_URL` from the repo `.env` at build time (default
`http://localhost:8787`) and passes it to `xcodebuild` as the `BINSIGHT_API_URL` build setting, which
lands in the app's Info.plist as `BinsightApiURL`. That URL is the only thing baked in. Auth is your
wallet **address + password** (the account you registered on the web), entered in the app's
**Settings**: the credentials go to the Keychain, and the URL can be overridden there too
(UserDefaults).

### Signing (for notifications)

`make install-mac` auto-signs with your local Apple Development cert if one exists (the app is
non-sandboxed, so no provisioning profile is needed); otherwise it falls back to an unsigned build.
A signed build is needed for native notifications.

### Manual / CLI checks

```sh
cd apps/BinsightKit && swift test     # or: make apps-test
```

## How it fits the system

While the macOS app is active, range/close events show as native macOS notifications; when it's away
(asleep / locked / idle) the backend routes to Bark instead. Mobile is covered by the web PWA
(Web Push).
