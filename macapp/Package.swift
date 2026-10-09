// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MacStreamApp",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "MacStreamApp", targets: ["MacStreamApp"])
    ],
    targets: [
        // Thin wrapper over libmpv's C API.
        //
        // Needed so mpv can render INTO a SwiftUI view instead of opening its own window. No system framework
        // decodes Matroska -- not AVPlayer, not QuickTime -- and every 4K stream this API returns is an MKV, so
        // "play inline" and "play 4K" are only compatible if mpv's own video output is embedded.
        .systemLibrary(name: "CMPV", path: "Sources/CMPV", pkgConfig: "mpv"),
        .executableTarget(
            name: "MacStreamApp",
            dependencies: ["CMPV"],
            path: "Sources/MacStreamApp",
            linkerSettings: [
                .unsafeFlags(["-L/opt/homebrew/lib", "-L/usr/local/lib"]),
                .linkedLibrary("mpv")
            ]
        )
    ]
)