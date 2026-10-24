import Foundation
import CryptoKit

struct UIAsset: Codable { let path: String; let bytes: Int; let sha256: String }
struct UIManifest: Codable { let success: Bool; let version: String; let assets: [UIAsset] }
struct UISyncResult { let reachable: Bool; let didUpdate: Bool }

final class StreamerUIStore {
    private let fm = FileManager.default
    private let cacheRoot: URL
    private let activeRoot: URL
    private let manifestURL: URL
    var server: String { UserDefaults.standard.string(forKey: "streamShelf.server") ?? "http://127.0.0.1:8787" }

    init() {
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!.appendingPathComponent("StreamShelf", isDirectory: true)
        cacheRoot = support.appendingPathComponent("StreamerUI", isDirectory: true)
        activeRoot = cacheRoot.appendingPathComponent("active", isDirectory: true)
        manifestURL = cacheRoot.appendingPathComponent("manifest.json")
        try? fm.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
    }

    func fileURL(_ relative: String) -> URL? {
        let cached = activeRoot.appendingPathComponent(relative)
        if fm.fileExists(atPath: cached.path) { return cached }
        guard let bundled = Bundle.module.resourceURL?.appendingPathComponent("Resources/streamer/\(relative)"), fm.fileExists(atPath: bundled.path) else { return nil }
        return bundled
    }

    func syncFromAPI() async -> UISyncResult {
        guard let manifestURL = URL(string: server + "/api/desktop-ui/manifest") else { return UISyncResult(reachable: false, didUpdate: false) }
        do {
            let (data, response) = try await URLSession.shared.data(from: manifestURL)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return UISyncResult(reachable: false, didUpdate: false) }
            let manifest = try JSONDecoder().decode(UIManifest.self, from: data)
            let current: UIManifest?
            if let existingData = try? Data(contentsOf: self.manifestURL) {
                current = try? JSONDecoder().decode(UIManifest.self, from: existingData)
            } else {
                current = nil
            }
            guard current?.version != manifest.version else { return UISyncResult(reachable: true, didUpdate: false) }

            let staging = cacheRoot.appendingPathComponent("staging-\(UUID().uuidString)", isDirectory: true)
            try fm.createDirectory(at: staging, withIntermediateDirectories: true)
            defer { try? fm.removeItem(at: staging) }
            for asset in manifest.assets {
                guard !asset.path.contains(".."), let encoded = asset.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed), let remote = URL(string: server + "/streamer/" + encoded) else { throw URLError(.badURL) }
                let (assetData, assetResponse) = try await URLSession.shared.data(from: remote)
                guard (assetResponse as? HTTPURLResponse)?.statusCode == 200,
                      AssetHash.hex(assetData) == asset.sha256 else { throw URLError(.cannotDecodeContentData) }
                let destination = staging.appendingPathComponent(asset.path)
                try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                try assetData.write(to: destination, options: .atomic)
            }
            let stagedManifest = staging.appendingPathComponent("manifest.json")
            try JSONEncoder().encode(manifest).write(to: stagedManifest, options: .atomic)
            let old = cacheRoot.appendingPathComponent("old-\(UUID().uuidString)")
            if fm.fileExists(atPath: activeRoot.path) { try fm.moveItem(at: activeRoot, to: old) }
            try fm.moveItem(at: staging, to: activeRoot)
            try? fm.removeItem(at: old)
            try JSONEncoder().encode(manifest).write(to: self.manifestURL, options: .atomic)
            return UISyncResult(reachable: true, didUpdate: true)
        } catch {
            return UISyncResult(reachable: false, didUpdate: false)
        }
    }
}

enum AssetHash {
    static func hex(_ data: Data) -> String {
        CryptoKit.SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
