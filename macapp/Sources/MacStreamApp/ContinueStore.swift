import Foundation

// Where "Continue Watching" lives.
//
// One JSON file in Application Support, written on stop and every ~10s of playback (a position
// saved only on clean exit is a position lost on crash, which is exactly when people close the
// app). Nothing here talks to the network; the player reports positions and this store decides
// what is worth remembering.

struct ContinueItem: Codable, Identifiable, Hashable {
    /// "movie:155" / "series:37854:s22e45" — one slot per title (movies) or per episode (series).
    var key: String
    var tmdbId: Int
    var type: String                 // "movie" | "series"
    var season: Int?
    var episode: Int?
    var title: String
    var subtitle: String?            // episode label / movie year
    var poster: String?
    var position: Double
    var duration: Double
    var updatedAt: Date

    var id: String { key }
    /// Finished episodes are dropped rather than listed, so this is a rare edge (a nearly-complete
    /// file whose last seconds never played).
    var progress: Double { duration > 0 ? min(1, max(0, position / duration)) : 0 }
}

@MainActor
final class ContinueStore: ObservableObject {
    @Published private(set) var items: [ContinueItem] = []

    private let maxItems = 50
    private let fileURL: URL

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".Library/Application Support")
        let dir = base.appendingPathComponent("MacStreamApp", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("continue-watching.json")
        load()
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode([ContinueItem].self, from: data) else { return }
        items = decoded.sorted { $0.updatedAt > $1.updatedAt }
    }

    private func persist() {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted]
        guard let data = try? enc.encode(items) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    /// Called with a live position. A finished title is REMOVED (95% is "done" for streaming —
    /// credits nobody sits through), and a position under 15s is not worth a card.
    func record(_ item: ContinueItem) {
        guard item.duration > 0 else { return }
        var entry = item
        if entry.position < 15 { remove(entry.key); return }
        if entry.progress >= 0.95 { remove(entry.key); return }
        entry.updatedAt = Date()
        items.removeAll { $0.key == entry.key }
        items.append(entry)
        items.sort { $0.updatedAt > $1.updatedAt }
        if items.count > maxItems { items.removeLast(items.count - maxItems) }
        persist()
    }

    func remove(_ key: String) {
        guard items.contains(where: { $0.key == key }) else { return }
        items.removeAll { $0.key == key }
        persist()
    }

    func clearAll() {
        items = []
        persist()
    }
}
