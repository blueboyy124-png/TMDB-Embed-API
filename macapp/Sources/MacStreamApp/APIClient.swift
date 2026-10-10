import Foundation

// Client for the local TMDB-Embed-API.
//
// Deliberately mirrors the Roku client's rules, because the same failure modes apply on both:
//  - the API reports failures inside a 200 body as well as via the status code, so `success: false` is
//    checked rather than assuming HTTP 200 means it worked
//  - a TMDB rate limit is not "no results" and must not be rendered as an empty list
//  - the base URL is editable at runtime, because the port changes and the app should not need a rebuild

struct APIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct SearchResult: Identifiable, Decodable, Hashable {
    let id: Int
    let type: String        // "movie" | "series"
    let title: String
    let overview: String?
    let poster: String?
    let year: String?
    let rating: Double?

    var isMovie: Bool { type == "movie" }
    var ref: TitleRef { TitleRef(id: id, type: type) }
}

/// A title to open: TMDB id plus which side of the API to talk to. Hashable so it can be a
/// navigation path value.
struct TitleRef: Hashable {
    let id: Int
    let type: String        // "movie" | "series"
}

struct EpisodeInfo: Decodable, Hashable {
    let name: String?
    let overview: String?
    let still: String?
    let airDate: String?
    let absoluteEpisode: Int?
}

struct Stream: Identifiable, Decodable, Hashable {
    let title: String?
    let name: String?
    let url: String
    let quality: String?
    let provider: String?
    let sourceTitle: String?
    let languageLabel: String?
    let language: String?
    let tag: String?
    let container: String?
    /// When this stream arrived, in ms from the start of the live feed. Assigned locally as rows land.
    var arrivalMs: Int = 0
    // Not in the API response; assigned locally so SwiftUI can tell rows apart.
    var id: String { "\(provider ?? "?")|\(url)" }

    var displayTitle: String { title ?? name ?? provider ?? "stream" }
}

struct StreamsResponse: Decodable {
    let success: Bool?
    let count: Int?
    let stopReason: String?
    let tagCounts: [String: Int]?
    let providerStatus: [String: String]?
    let pending: [String]?
    let streams: [Stream]?
    let title: String?
    let overview: String?
    let release_date: String?
    let poster_path: String?
    let metadata: Metadata?
    /// The provider-direct route (`/api/streams/:provider/...`) puts the episode
    /// block top-level instead of under metadata. Same shape, different address.
    let episode: EpisodeInfo?
    let providerTimings: [String: Int]?

    struct Metadata: Decodable {
        let title: String?
        let episode: EpisodeInfo?
        let anilist: AniList?
        struct AniList: Decodable { let id: Int? }
    }
}

struct SearchResponse: Decodable {
    let success: Bool?
    let results: [SearchResult]?
}

struct Episode: Decodable, Identifiable, Hashable {
    // Wire shape is `season` / `episode` / `still` (a full image URL), per
    // GET /api/metadata/series/:id/episodes. The previous model read
    // seasonNumber / episodeNumber / stillPath, none of which exist, so every
    // episode decoded to S0E0 and picking one silently loaded S1E1.
    let season: Int?
    let episode: Int?
    let name: String?
    let airDate: String?
    let overview: String?
    let still: String?
    let absoluteEpisode: Int?
    let seasonRelativeEpisode: Int?
    let runtime: Int?
    let rating: Double?

    var id: String { "s\(season ?? 0)e\(episode ?? 0)" }
    var label: String { "S\(season ?? 0)E\(episode ?? 0)" }
    /// The episode's real number in this season (the API's position-based
    /// `episode` is authoritative; `seasonRelativeEpisode` is the same value).
    var number: Int? { episode ?? seasonRelativeEpisode }
}

struct EpisodesResponse: Decodable {
    let success: Bool?
    let episodes: [Episode]?
    let season: Int?
    let seasonName: String?
    let totalEpisodes: Int?
    let warnings: [String]?
    let metadataError: String?
}

/// GET /api/metadata/:type/:tmdbId — the title screen in one call.
struct TitleDetails: Decodable, Identifiable, Hashable {
    let success: Bool?
    let tmdbId: String?
    let type: String?
    let title: String?
    let overview: String?
    let tagline: String?
    let status: String?
    let genres: [String]?
    let poster: String?
    let backdrop: String?
    let logo: String?
    let releaseDate: String?
    let year: Int?
    let runtime: Int?
    let voteAverage: Double?
    let seasonCount: Int?
    /// [[season number, episode count], ...] — everything the season picker needs.
    let episodeCounts: [[Int]]?
    let isAnime: Bool?
    let metadataError: String?

    var id: String { tmdbId ?? title ?? "?" }
    var seasons: [(number: Int, count: Int)] {
        (episodeCounts ?? []).compactMap { pair in
            guard let n = pair.first else { return nil }
            return (n, pair.count > 1 ? pair[1] : 0)
        }
    }
}

struct TrendingResponse: Decodable {
    let success: Bool?
    let results: [SearchResult]?
}

// MARK: - Live feed

/// One `stream` event off the SSE endpoint: a single provider's results, the instant it settles.
struct LiveProviderEvent: Decodable {
    let provider: String
    let status: String?
    let arrivalMs: Int?
    let count: Int?
    let streams: [Stream]?
}

/// Consumes `/api/streams/.../live` and publishes results as they arrive.
///
/// This is what removes the waiting. The JSON endpoint has to decide when it has a complete-enough answer and
/// then return one blob; measured, that either cost ~12s waiting for 4K or returned in 2.5s with no 4K at all,
/// depending on timing. The live feed has neither problem: a provider's streams land the moment it finishes, so
/// the list is usable at ~2.5s and the 4K provider's results simply appear underneath whatever you are playing
/// several seconds later.
@MainActor
final class LiveStreamFeed: NSObject, URLSessionDataDelegate {
    /// Called after every state change.
    ///
    /// Deliberately a closure rather than this object being observed itself. The views observe AppModel, and a
    /// nested ObservableObject's @Published changes do NOT propagate through it -- the feed was filling up
    /// correctly the whole time and the list stayed empty because nothing was listening.
    var onChange: (() -> Void)?

    var arrived: [Stream] = []
    var isLoading = false
    var finished = false
    var stopReason: String?
    var errorText: String?

    private var task: URLSessionTask?
    private var buffer = ""
    private var seen = Set<String>()               // provider names already applied
    private var session: URLSession?

    func start(type: String, id: Int, season: Int?, episode: Int?, server: String, deadline: Int = 30000) {
        cancel()
        arrived = []
        finished = false
        stopReason = nil
        errorText = nil
        isLoading = true
        seen = []

        var path: String
        if type == "movie" {
            path = "/api/streams/movie/\(id)/live?deadline=\(deadline)"
        } else {
            path = "/api/streams/series/\(id)/live?season=\(season ?? 1)&episode=\(episode ?? 1)&deadline=\(deadline)"
        }
        guard let url = URL(string: server.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + path) else {
            errorText = "Bad server address"
            isLoading = false
            return
        }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Double(deadline) / 1000.0 + 30
        // The session must be retained, or it is deallocated the moment this function returns and the stream
        // dies with it. Holding it here is what keeps the connection alive.
        let s = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        session = s
        task = s.dataTask(with: url)
        task?.resume()
    }

    func cancel() {
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
        buffer = ""
    }

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        Task { @MainActor in self.consume(text) }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Task { @MainActor in
            self.isLoading = false
            self.finished = true
        }
    }

    /// Pulls complete SSE frames out of a chunk.
    ///
    /// Frames can be split across network chunks, so the remainder is kept in `buffer` for the next call.
    /// Splitting on every newline instead would silently drop anything that arrived mid-frame, which shows
    /// up as randomly missing providers.
    private func consume(_ text: String) {
        buffer += text
        while let range = buffer.range(of: "\n\n") {
            let frame = String(buffer[buffer.startIndex..<range.lowerBound])
            buffer = String(buffer[range.upperBound...])
            guard let nameRange = frame.range(of: "event: "),
                  let dataRange = frame.range(of: "data: ") else { continue }
            let event = String(frame[nameRange.upperBound...].prefix { $0 != "\n" })
            let json = String(frame[dataRange.upperBound...].prefix { $0 != "\n" })
            guard let data = json.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            apply(event, obj)
        }
        // One notification after the whole chunk, not one per frame: a burst of frames in one read would
        // otherwise republish many times and is exactly the kind of churn that makes a list feel laggy.
        onChange?()
    }

    private func apply(_ event: String, _ obj: [String: Any]) {
        switch event {
        case "stream":
            let provider = obj["provider"] as? String ?? "?"
            guard !seen.contains(provider) else { return }    // one event per provider; idempotent anyway
            seen.insert(provider)
            let arrival = obj["arrivalMs"] as? Int ?? 0
            for raw in (obj["streams"] as? [[String: Any]]) ?? [] {
                guard let u = raw["url"] as? String, !u.isEmpty else { continue }
                let base = Stream(
                    title: raw["title"] as? String, name: raw["name"] as? String, url: u,
                    quality: raw["quality"] as? String, provider: raw["provider"] as? String ?? provider,
                    sourceTitle: raw["sourceTitle"] as? String,
                    languageLabel: raw["languageLabel"] as? String, language: raw["language"] as? String,
                    tag: raw["tag"] as? String, container: raw["container"] as? String
                )
                // Raw provider output carries no container; derive it from the URL now so
                // the UI can label rows (MKV, mp4, ...) while they are still streaming in.
                arrived.append(base.derived().withArrival(arrival))
            }
        case "done":
            stopReason = obj["stopReason"] as? String
            isLoading = false
            finished = true
        case "error":
            errorText = (obj["message"] as? String) ?? "Request failed"
            isLoading = false
        default:
            break
        }
    }
}

extension Stream {
    enum CodingKeys: String, CodingKey {
        case title, name, url, quality, provider, sourceTitle
        case languageLabel, language, tag, container, arrivalMs
    }

    /// arrivalMs is stamped locally when a row lands — the API never sends it, so its
    /// absence must fall back to 0 instead of failing the whole response. (The
    /// synthesized init requires every non-optional key, default value or not.)
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        url = try c.decode(String.self, forKey: .url)
        quality = try c.decodeIfPresent(String.self, forKey: .quality)
        provider = try c.decodeIfPresent(String.self, forKey: .provider)
        sourceTitle = try c.decodeIfPresent(String.self, forKey: .sourceTitle)
        languageLabel = try c.decodeIfPresent(String.self, forKey: .languageLabel)
        language = try c.decodeIfPresent(String.self, forKey: .language)
        tag = try c.decodeIfPresent(String.self, forKey: .tag)
        container = try c.decodeIfPresent(String.self, forKey: .container)
        arrivalMs = try c.decodeIfPresent(Int.self, forKey: .arrivalMs) ?? 0
    }

    /// Copy with a container derived from the URL when the server did not supply one.
    func derived() -> Stream {
        guard container == nil || container == "" else { return self }
        // Look through the proxy: with it on, every URL is /ts-proxy?url=<encoded .mkv>, and a bare extension
        // test on the visible URL finds nothing.
        var target = url
        if let r = URLComponents(string: url), let q = r.queryItems?.first(where: { $0.name == "url" })?.value {
            target = q.removingPercentEncoding ?? q
        }
        var ext = ""
        if let e = URL(string: target)?.pathExtension, e.count <= 5 { ext = e.lowercased() }
        if ext.isEmpty && target.contains("m3u8-proxy") { ext = "m3u8" }
        return Stream(
            title: title, name: name, url: url, quality: quality, provider: provider,
            sourceTitle: sourceTitle, languageLabel: languageLabel, language: language,
            tag: tag, container: ext.isEmpty ? nil : ext
        )
    }

    /// Arrival time in ms, so the list can show which source was fast and which was the 4K that came late.
    func withArrival(_ ms: Int) -> Stream {
        Stream(
            title: title, name: name, url: url, quality: quality, provider: provider,
            sourceTitle: sourceTitle, languageLabel: languageLabel, language: language,
            tag: tag, container: container, arrivalMs: ms
        )
    }
}

enum API {
    // Editable in the UI; the API's port is not fixed forever.
    // Not @MainActor: the request helpers below are nonisolated async funcs and this is a plain string
    // they read. Isolating it would drag every call site onto the main actor for no benefit.
    nonisolated(unsafe) static var base = "http://127.0.0.1:8787"

    private static func url(_ path: String) -> URL? {
        URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + path)
    }

    private static func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        guard let u = url(path) else { throw APIError(message: "Bad server address") }
        var req = URLRequest(url: u)
        req.timeoutInterval = 90          // the aggregate endpoint can legitimately take ~20s
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let status: Int
        do {
            let (d, r) = try await URLSession.shared.data(for: req)
            data = d
            status = (r as? HTTPURLResponse)?.statusCode ?? -1
        } catch let e as URLError {
            throw APIError(message: "Cannot reach \(u.host ?? "the server") (\(e.localizedDescription)) — is the API running there?")
        }
        // A wrong port commonly answers with a dev-server or proxy HTML page, which is not
        // JSON. Name the host, port, path and status so a :5500-vs-:8787 mixup is obvious
        // instead of looking like the address is wrong.
        guard let decoded = try? JSONDecoder().decode(T.self, from: data) else {
            let head = String(data: data.prefix(120), encoding: .utf8) ?? "(binary)"
            let where_ = "\(u.host ?? "?"):\(u.port ?? 0)\(u.path)"
            throw APIError(message: "HTTP \(status) from \(where_) — not API JSON (\(head)). The API is usually on :8787.")
        }
        return decoded
    }

    static func streams(type: String, id: Int, season: Int?, episode: Int?, deadline: Int = 30000) async throws -> StreamsResponse {
        var path: String
        if type == "movie" {
            path = "/api/streams/movie/\(id)?deadline=\(deadline)"
        } else {
            let s = season ?? 1
            let e = episode ?? 1
            path = "/api/streams/series/\(id)?season=\(s)&episode=\(e)&deadline=\(deadline)"
        }
        return try await get(path, as: StreamsResponse.self)
    }

    static func episodes(type: String, id: Int, season: Int) async throws -> EpisodesResponse {
        try await get("/api/metadata/\(type)/\(id)/episodes?season=\(season)", as: EpisodesResponse.self)
    }

    /// Title screen: poster/backdrop, overview, genres, and the season list.
    static func metadata(type: String, id: Int) async throws -> TitleDetails {
        try await get("/api/metadata/\(type)/\(id)", as: TitleDetails.self)
    }

    /// One provider only, straight JSON (no live feed). Used for the 4khdhub-default
    /// mode: the aggregate's other providers can neither slow it down nor pollute it.
    static func providerStreams(provider: String, type: String, id: Int, season: Int?, episode: Int?) async throws -> StreamsResponse {
        var path: String
        if type == "movie" {
            path = "/api/streams/\(provider)/movie/\(id)"
        } else {
            path = "/api/streams/\(provider)/series/\(id)?season=\(season ?? 1)&episode=\(episode ?? 1)"
        }
        return try await get(path, as: StreamsResponse.self)
    }

    static func search(_ q: String) async throws -> SearchResponse {
        let encoded = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
        return try await get("/api/search?q=\(encoded)", as: SearchResponse.self)
    }

    static func trending() async throws -> TrendingResponse {
        try await get("/api/trending?window=week", as: TrendingResponse.self)
    }
}