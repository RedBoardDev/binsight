// swift-tools-version: 6.2
import PackageDescription

// macOS 26 deployment target: this is a personal, non-distributed menu-bar app built against the
// macOS 26 SDK, so pinning the old 14.0 minimum bought nothing and forced `#available` guards around
// every current API (Liquid Glass button styles among them). 26.0 rather than 26.5 because SDK
// availability is annotated against the major version almost everywhere.
let package = Package(
    name: "BinsightKit",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "BinsightKit", targets: ["BinsightKit"]),
    ],
    targets: [
        .target(name: "BinsightKit"),
        .testTarget(name: "BinsightKitTests", dependencies: ["BinsightKit"]),
    ],
    swiftLanguageModes: [.v6],
)
