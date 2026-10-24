// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "StreamShelf",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "StreamShelf", targets: ["StreamShelf"])],
    targets: [
        .executableTarget(
            name: "StreamShelf",
            resources: [.copy("Resources")]
        )
    ]
)
