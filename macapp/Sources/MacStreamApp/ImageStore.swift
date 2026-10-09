import AppKit

// Poster/still/backdrop loading with a real cache.
//
// TMDB images are re-requested constantly by scrolling grids (a poster's URL never changes, so
// URLSession's URLCache alone evicts under memory pressure and re-downloads). This keeps an
// in-memory NSCache keyed by URL, de-duplicates concurrent requests for the same image, and
// always delivers on the main actor so views can just assign.

@MainActor
final class ImageStore {
    static let shared = ImageStore()

    private let cache = NSCache<NSURL, NSImage>()
    private var inflight: [URL: Task<NSImage?, Never>] = [:]
    private let session: URLSession

    private init() {
        // Memory: ~60 posters at w342 (~20KB each) is nothing; caps protect against a
        // pathological run of w1280 backdrops.
        cache.countLimit = 300
        cache.totalCostLimit = 40 * 1024 * 1024
        let cfg = URLSessionConfiguration.default
        cfg.urlCache = URLCache(memoryCapacity: 32 * 1024 * 1024, diskCapacity: 128 * 1024 * 1024)
        cfg.requestCachePolicy = .returnCacheDataElseLoad
        session = URLSession(configuration: cfg)
    }

    func image(for urlString: String?) async -> NSImage? {
        guard let urlString, let url = URL(string: urlString) else { return nil }
        if let hit = cache.object(forKey: url as NSURL) { return hit }
        if let task = inflight[url] { return await task.value }

        let task = Task<NSImage?, Never> { [session, cache] in
            guard let (data, resp) = try? await session.data(from: url),
                  (resp as? HTTPURLResponse)?.statusCode ?? 200 < 300,
                  let img = NSImage(data: data) else { return nil }
            // Cost is bytes, so a big backdrop evicts proportionally rather than one slot each.
            cache.setObject(img, forKey: url as NSURL, cost: data.count)
            return img
        }
        inflight[url] = task
        let result = await task.value
        inflight[url] = nil
        return result
    }
}
