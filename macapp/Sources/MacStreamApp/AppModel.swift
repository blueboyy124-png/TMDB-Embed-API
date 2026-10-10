import SwiftUI

// Navigation and data orchestration. Playback state lives in PlaybackController; this class
// decides WHAT is on screen (discover / search / title detail) and fetches what those screens
// need. Split from the original god-object so a section change cannot disturb a playing stream.
//
// Loading contract: views push a TitleRef onto `path`; the detail destination calls
// `ensureLoaded(ref)` when it appears. Actions that need extra behaviour (resume at a saved
// position, open at a specific season/episode) stage that as pendingResume / pendingWant
// BEFORE pushing, and ensureLoaded consumes it exactly once — no matter which path (fresh
// push, already-open title, re-render) ends up doing the work.

@MainActor
final class AppModel: ObservableObject {
    /// Where the sidebar is pointed. Title details are pushed onto `path` on top of this.
    enum Section: String, CaseIterable, Identifiable {
        case discover, search, settings
        var id: String { rawValue }
        var title: String {
            switch self {
            case .discover: return "Discover"
            case .search: return "Search"
            case .settings: return "Settings"
            }
        }
        var icon: String {
            switch self {
            case .discover: return "play.house"
            case .search: return "magnifyingglass"
            case .settings: return "gearshape"
            }
        }
    }

    /// 4khdhub is the default: it covers anime, TV and movies in high quality, and asking one
    /// provider directly skips the aggregate wait entirely.
    enum ProviderMode: String, CaseIterable, Identifiable {
        case fourk = "4khdhub"
        case anime = "anime"
        case all = "All"
        var id: String { rawValue }
        /// nil = aggregate live feed; otherwise a provider-direct JSON request.
        var apiName: String? {
            switch self {
            case .fourk: return "4khdhub"
            case .anime: return "anime"
            case .all: return nil
            }
        }
    }

    // MARK: navigation
    @Published var section: Section = .discover
    @Published var path: [TitleRef] = []

    // MARK: settings (persisted)
    @Published var server: String {
        didSet {
            API.base = server
            UserDefaults.standard.set(server, forKey: "server")
        }
    }
    @Published var providerMode: ProviderMode {
        didSet { UserDefaults.standard.set(providerMode.rawValue, forKey: "providerMode") }
    }

    // MARK: discover
    @Published var trending: [SearchResult] = []
    @Published var isLoadingTrending = false
    @Published var trendingError: String?

    // MARK: search
    @Published var searchQuery = ""
    @Published var searchResults: [SearchResult] = []
    @Published var searchError: String?
    @Published var isSearching = false

    // MARK: title detail
    @Published var detail: TitleDetails?
    @Published var detailRef: TitleRef?
    @Published var selectedSeason = 1
    @Published var selectedEpisode: Episode?
    @Published var episodes: [Episode] = []
    @Published var isLoadingEpisodes = false
    private var detailLoading = false
    private var pendingResume: ContinueItem?
    private var pendingWant: (season: Int?, episode: Int?)?

    @Published var streams: [Stream] = []
    @Published var streamResponse: StreamsResponse?
    @Published var isLoadingStreams = false
    @Published var streamsElapsed: Int?
    @Published var streamsError: String?
    /// Set while an aggregate (live) load is waiting for its first rows so an auto-play can
    /// fire the moment anything arrives (the value is the resume position to start at).
    private var pendingAutoPlay: Double?

    // MARK: owned services
    let playback: PlaybackController
    let store: ContinueStore
    let mpv = MPVRunner()
    /// Live feed for the "All" provider mode. Streams land as each provider settles.
    let live = LiveStreamFeed()

    // MARK: init

    init() {
        let defaults = UserDefaults.standard
        server = defaults.string(forKey: "server") ?? "http://127.0.0.1:8787"
        if let raw = defaults.string(forKey: "providerMode"), let m = ProviderMode(rawValue: raw) {
            providerMode = m
        } else {
            providerMode = .fourk
        }
        let store = ContinueStore()
        self.store = store
        self.playback = PlaybackController(store: store)
        API.base = server
        // The feed is a nested ObservableObject: its @Published changes do NOT propagate
        // through this object, so it hand-notifies (the bug that once left a silently
        // empty list while the feed filled correctly).
        live.onChange = { [weak self] in
            self?.liveArrived()
        }
    }

    private func liveArrived() {
        streams = live.arrived
        // Keep a running player's row list in step with the feed (raw rows land early, the
        // link-checked payload supersedes them later — see PlaybackController.refreshRows).
        playback.refreshRows(streams)
        if streamsElapsed == nil, let maxArrival = live.arrived.map(\.arrivalMs).max() {
            streamsElapsed = maxArrival
        }
        if let resume = pendingAutoPlay, !streams.isEmpty {
            pendingAutoPlay = nil
            let snapshot = streams
            // Probe candidates while the loading spinner already covers the wait — auto-play
            // must not open on a row we can see is dead.
            Task { [weak self] in
                guard let self else { return }
                play(await preflight(snapshot), resume: resume)
            }
        }
        objectWillChange.send()
    }
    // MARK: discover

    func loadTrendingIfNeeded() {
        guard trending.isEmpty, !isLoadingTrending else { return }
        API.base = server
        isLoadingTrending = true
        trendingError = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                trending = try await API.trending().results ?? []
                if trending.isEmpty { trendingError = "Trending is empty right now" }
            } catch {
                trendingError = error.localizedDescription
            }
            isLoadingTrending = false
        }
    }

    // MARK: search

    func doSearch() {
        let q = searchQuery.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        API.base = server
        isSearching = true
        searchError = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                searchResults = try await API.search(q).results ?? []
                if searchResults.isEmpty { searchError = "Nothing found for “\(q)”" }
            } catch {
                searchResults = []
                searchError = error.localizedDescription
            }
            isSearching = false
        }
    }

    // MARK: opening titles

    /// Open a title's detail page (search result, trending tile, continue card info button).
    func open(_ ref: TitleRef) {
        pendingResume = nil
        pendingWant = nil
        push(ref)
    }

    /// Open a raw TMDB id (Settings' opener), optionally at a season/episode.
    func openById(type: String, id: Int, season: Int? = nil, episode: Int? = nil) {
        pendingResume = nil
        pendingWant = (season, episode)
        push(TitleRef(id: id, type: type))
    }

    /// Continue Watching: open the title (or reuse the open one), select the saved episode,
    /// and play the first row at the saved position. The player screen is entered immediately —
    /// the spinner covers the fetch, exactly like pressing Play.
    func resume(_ item: ContinueItem) {
        pendingResume = item
        pendingWant = nil
        playback.mode = .watching
        push(TitleRef(id: item.tmdbId, type: item.type))
    }

    /// The detail page's Play button: switch to the player screen NOW (loading state while
    /// streams resolve) and either replay the rows already in hand or kick a load with
    /// auto-play. `resume` is the saved position when the title is partially watched.
    func playFromDetail(resume: Double = 0) {
        playback.mode = .watching
        if !streams.isEmpty {
            let snapshot = streams
            // Preflight picks the first live row; the spinner is already up while it probes.
            Task { [weak self] in
                guard let self else { return }
                play(await preflight(snapshot), resume: resume)
            }
        } else if !isLoadingStreams {
            playSelected(resume: resume)
        } else {
            // A fetch is already running (the detail opened seconds ago) — stage the
            // auto-play on it instead of restarting the fetch from scratch.
            pendingAutoPlay = resume
        }
    }

    /// The saved Continue Watching item for a title as currently selected (series: this
    /// episode), so the detail page can label its button Play vs Resume.
    func continueItemForCurrentSelection() -> ContinueItem? {
        guard let ref = detailRef else { return nil }
        let key: String
        if ref.type == "series" {
            let s = selectedEpisode?.season ?? selectedSeason
            let e = selectedEpisode?.number ?? selectedEpisode?.episode ?? 1
            key = "series:\(ref.id):s\(s)e\(e)"
        } else {
            key = "movie:\(ref.id)"
        }
        return store.items.first { $0.key == key }
    }

    private func push(_ ref: TitleRef) {
        if path.last != ref { path.append(ref) }
        // The destination's .task will also call ensureLoaded; whichever runs first does the
        // work and the other sees detailLoading / an unchanged ref and returns.
        ensureLoaded(ref)
    }

    /// Called by the detail destination. Idempotent.
    func ensureLoaded(_ ref: TitleRef) {
        if detailRef == ref, detailLoading { return }
        let resume = pendingResume
        let want = pendingWant
        pendingResume = nil
        pendingWant = nil
        if detailRef == ref, detail != nil {
            // Already on this title: consume the staged action, do not refetch metadata.
            if let resume { applyResume(resume) }
            else if let want { applyWant(want) }
            return
        }
        loadDetail(ref, resume: resume, want: want)
    }

    private func loadDetail(_ ref: TitleRef, resume: ContinueItem?, want: (season: Int?, episode: Int?)?) {
        API.base = server
        detailLoading = true
        detailRef = ref
        detail = nil
        episodes = []
        selectedEpisode = nil
        selectedSeason = resume?.season ?? want?.season ?? 1
        streams = []
        streamResponse = nil
        streamsElapsed = nil
        streamsError = nil
        pendingAutoPlay = resume?.position

        Task { [weak self] in
            guard let self else { return }
            defer { detailLoading = false }
            do {
                detail = try await API.metadata(type: ref.type, id: ref.id)
            } catch {
                // A missing title screen must not block playback — streams matter more.
                detail = nil
                streamsError = "Metadata unavailable: \(error.localizedDescription)"
            }
            if ref.type == "series" {
                await loadEpisodesSeason(selectedSeason)
                let wantEp = resume?.episode ?? want?.episode
                if let w = wantEp,
                   let match = episodes.first(where: { $0.number == w || $0.episode == w }) {
                    selectedEpisode = match
                }
            }
            await loadStreams(autoPlay: resume != nil, resume: resume?.position ?? 0)
        }
    }

    /// A resume aimed at a title whose detail is already loaded.
    private func applyResume(_ item: ContinueItem) {
        Task { [weak self] in
            guard let self else { return }
            if let s = item.season, s != selectedSeason {
                selectedSeason = s
                await loadEpisodesSeason(s)
            }
            if let s = item.season, let e = item.episode,
               let match = episodes.first(where: { $0.season == s && ($0.number == e || $0.episode == e) }) {
                selectedEpisode = match
            }
            await loadStreams(autoPlay: true, resume: item.position)
        }
    }

    /// An open-at-season/episode aimed at a title whose detail is already loaded.
    private func applyWant(_ want: (season: Int?, episode: Int?)) {
        Task { [weak self] in
            guard let self else { return }
            if let s = want.season, s != selectedSeason {
                selectedSeason = s
                await loadEpisodesSeason(s)
            }
            if let w = want.episode,
               let match = episodes.first(where: { $0.number == w || $0.episode == w }) {
                selectedEpisode = match
            }
            await loadStreams(autoPlay: false, resume: 0)
        }
    }

    // MARK: seasons / episodes

    func selectSeason(_ n: Int) {
        guard n >= 1, n != selectedSeason else { return }
        selectedSeason = n
        selectedEpisode = nil
        Task { [weak self] in
            await self?.loadEpisodesSeason(n)
            await self?.loadStreams(autoPlay: false, resume: 0)
        }
    }

    private func loadEpisodesSeason(_ n: Int) async {
        guard let ref = detailRef, ref.type == "series" else { return }
        isLoadingEpisodes = true
        defer { isLoadingEpisodes = false }
        do {
            let r = try await API.episodes(type: "series", id: ref.id, season: n)
            episodes = r.episodes ?? []
            selectedEpisode = episodes.first
        } catch {
            episodes = []
        }
    }

    func selectEpisode(_ e: Episode) {
        guard e != selectedEpisode else { return }
        selectedEpisode = e
        if let s = e.season, s != selectedSeason { selectedSeason = s }
        Task { [weak self] in
            await self?.loadStreams(autoPlay: false, resume: 0)
        }
    }

    /// Episode card's play affordance: select AND play in one load (select + playSelected
    /// as separate calls would race two fetches against each other).
    func selectAndPlay(_ e: Episode) {
        selectedEpisode = e
        if let s = e.season, s != selectedSeason { selectedSeason = s }
        Task { [weak self] in
            await self?.loadStreams(autoPlay: true, resume: 0)
        }
    }

    /// Plays the selected episode (used by episode cards and the detail Play button).
    func playSelected(resume: Double = 0) {
        Task { [weak self] in
            guard let self else { return }
            await loadStreams(autoPlay: true, resume: resume)
        }
    }

    /// Whether there IS a next/previous episode to go to (season-boundary aware).
    func canAdvanceEpisode(_ delta: Int) -> Bool {
        guard let ref = detailRef, ref.type == "series",
              let cur = selectedEpisode, let n = cur.number else { return false }
        if delta > 0 {
            if n < episodes.count { return true }
            let seasonCount = detail?.seasonCount ?? 0
            return selectedSeason < seasonCount
        } else {
            return n > 1 || selectedSeason > 1
        }
    }

    /// Next/previous episode from the player or the grid. Crosses season boundaries (the
    /// boundary season's episodes are fetched, then the edge episode is chosen) and auto-plays.
    func advanceEpisode(_ delta: Int) async -> Bool {
        guard let ref = detailRef, ref.type == "series",
              let cur = selectedEpisode, let curNum = cur.number else { return false }
        var targetSeason = selectedSeason
        var targetNum = curNum + delta
        if targetNum > episodes.count {
            targetSeason += 1
            await loadEpisodesSeason(targetSeason)
            selectedSeason = targetSeason
            targetNum = 1
            guard !episodes.isEmpty else { return false }
        } else if targetNum < 1 {
            guard selectedSeason > 1 else { return false }
            targetSeason -= 1
            await loadEpisodesSeason(targetSeason)
            selectedSeason = targetSeason
            targetNum = max(1, episodes.count)
            guard !episodes.isEmpty else { return false }
        }
        guard episodes.indices.contains(targetNum - 1) else { return false }
        selectedEpisode = episodes[targetNum - 1]
        await loadStreams(autoPlay: true, resume: 0)
        return true
    }

    // MARK: streams

    /// Fetches streams for the current detail + episode selection.
    func loadStreams(autoPlay: Bool, resume: Double) async {
        guard let ref = detailRef else { return }
        API.base = server
        streamsError = nil
        streams = []
        streamResponse = nil
        streamsElapsed = nil
        pendingAutoPlay = autoPlay ? resume : nil

        var s: Int? = nil, e: Int? = nil
        if ref.type == "series" {
            s = selectedEpisode?.season ?? selectedSeason
            e = selectedEpisode?.number ?? selectedEpisode?.episode ?? 1
        }

        if let api = providerMode.apiName {
            live.cancel()
            isLoadingStreams = true
            let t0 = Date()
            do {
                let r = try await API.providerStreams(provider: api, type: ref.type, id: ref.id, season: s, episode: e)
                let ms = r.providerTimings?.values.first ?? Int(Date().timeIntervalSince(t0) * 1000)
                let rows = (r.streams ?? []).map { $0.derived().withArrival(ms) }
                streams = rows
                streamResponse = r
                streamsElapsed = ms
                if rows.isEmpty {
                    streamsError = "\(api) returned no streams for this title"
                    pendingAutoPlay = nil
                } else if let resume = pendingAutoPlay, !rows.isEmpty {
                    // pendingAutoPlay is staged either by the autoPlay argument OR by a Play
                    // pressed while this very fetch was in flight — consume whoever staged it.
                    pendingAutoPlay = nil
                    Task { [weak self] in
                        guard let self else { return }
                        play(await preflight(rows), resume: resume)
                    }
                }
            } catch {
                streamsError = error.localizedDescription
                pendingAutoPlay = nil
            }
            isLoadingStreams = false
            return
        }

        // Aggregate live feed: rows land as providers settle. liveArrived() fires the
        // auto-play when the first row arrives.
        isLoadingStreams = true
        if ref.type == "movie" {
            live.start(type: "movie", id: ref.id, season: nil, episode: nil, server: server)
        } else {
            live.start(type: "series", id: ref.id, season: s, episode: e, server: server)
        }
        isLoadingStreams = false
    }

    /// Plays a row from the current stream list, with the current title as context.
    func play(_ stream: Stream, resume: Double = 0) {
        playback.start(stream, rows: streams, context: makeContext(), resume: resume)
    }

    // MARK: row preflight

    /// Auto-play used to trust `rows.first` blindly. When a provider's CDN gates every link
    /// (Febbox/shegu answers 403 across the board some days), that is an endless spinner on
    /// row 1 while live rows sit unused below it. This probes the top candidates through the
    /// exact URLs mpv will use and returns the first that actually answers. Probes are tiny
    /// (Range headers, ≤1KB) and run in parallel; if every probe fails the row list is tried
    /// blind anyway, because a probe can lie but the player cannot.
    func preflight(_ rows: [Stream]) async -> Stream {
        let candidates = Array(rows.prefix(10))
        guard candidates.count > 1, candidates.first?.url != nil else { return rows[0] }
        let results = await withTaskGroup(of: (Int, Bool).self) { group -> [(Int, Bool)] in
            for (i, row) in candidates.enumerated() {
                group.addTask { (i, await self.probeRow(row)) }
            }
            var out: [(Int, Bool)] = []
            for await r in group { out.append(r) }
            return out
        }
        let alive = results.filter { $0.1 }.map { $0.0 }.sorted()
        if let best = alive.first {
            if best > 0 {
                MPVController.log("preflight: row \(best + 1) is the first live row (\(alive.count)/\(candidates.count) probed alive)")
            }
            return candidates[best]
        }
        MPVController.log("preflight: no live rows in the top \(candidates.count) — trying row 1 blind")
        return rows[0]
    }

    /// True when the row's URL answers 2xx with something plausibly playable (playlists must
    /// actually look like a playlist — the m3u8-proxy answers dead links with a JSON error).
    private func probeRow(_ row: Stream) async -> Bool {
        guard let url = URL(string: row.url) else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 5
        req.setValue("bytes=0-1023", forHTTPHeaderField: "Range")
        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: req)
            defer { bytes.task.cancel() }
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                return false
            }
            let isPlaylist = row.url.lowercased().contains(".m3u8")
                || response.mimeType?.range(of: "mpegurl", options: .caseInsensitive) != nil
            guard isPlaylist else { return true }   // media: the status is enough; cancel via defer
            var head = ""
            for try await line in bytes.lines {
                head += line + "\n"
                if head.contains("#EXTM3U") { return true }
                if head.count > 512 { return false }
            }
            return false
        } catch {
            return false
        }
    }

    func makeContext() -> PlaybackController.Context {
        let d = detail
        let ref = detailRef
        let ep = selectedEpisode
        let subtitle: String?
        if ref?.type == "series" {
            let label = ep?.label ?? "S\(selectedSeason)"
            subtitle = ep?.name.map { "\(label) · \($0)" } ?? label
        } else {
            subtitle = d?.year.map(String.init)
        }
        return PlaybackController.Context(
            title: d?.title ?? "Title \(ref?.id ?? 0)",
            subtitle: subtitle,
            poster: d?.poster ?? ep?.still,
            tmdbId: ref?.id,
            type: ref?.type,
            season: ref?.type == "series" ? (ep?.season ?? selectedSeason) : nil,
            episode: ref?.type == "series" ? (ep?.number ?? ep?.episode) : nil
        )
    }

    // MARK: diagnostics (kept from the test harness — shown under the detail's streams)

    struct Check: Identifiable {
        let id = UUID()
        let label: String
        let ok: Bool?      // nil = not applicable (a movie has no episode)
    }

    /// The "did it have all its data" answer, computed from the response rather than from
    /// what happened to render — so a gap in the API shows up as a gap instead of a blank panel.
    var checks: [Check] {
        let m = streamResponse?.metadata
        let ep = m?.episode ?? streamResponse?.episode
        func nonEmpty(_ s: String?) -> Bool { !(s ?? "").isEmpty }
        return [
            Check(label: "title", ok: nonEmpty(ep?.name ?? streamResponse?.title ?? detail?.title)),
            Check(label: "description", ok: nonEmpty(ep?.overview ?? streamResponse?.overview ?? detail?.overview)),
            Check(label: "still / poster", ok: (ep?.still ?? streamResponse?.poster_path ?? detail?.poster) != nil),
            Check(label: "air / release date", ok: (ep?.airDate ?? streamResponse?.release_date ?? detail?.releaseDate) != nil),
            Check(label: "absolute episode", ok: detailRef?.type == "movie" ? nil : (ep?.absoluteEpisode != nil)),
            Check(label: "tagged", ok: streamResponse?.tagCounts.map { !$0.isEmpty } ?? nil),
            Check(label: "AniList cross-ref", ok: detailRef?.type == "movie" ? nil : (m?.anilist?.id != nil))
        ]
    }

    /// Sources that answered. More than one is what makes a title reliable, so a single source
    /// is called out rather than left for the viewer to notice on their own.
    var sourceBreakdown: [(String, Int)] {
        var counts: [String: Int] = [:]
        for s in streams { counts[s.provider ?? "?", default: 0] += 1 }
        return counts.sorted { $0.value > $1.value }
    }

    // MARK: self-test hook

    /// POISON_REFUSED=n / POISON_EMPTY=n (self-test only): rewrite rows before the autoplay
    /// preflight so both failure paths can be exercised on a day when every real link works.
    ///   POISON_REFUSED — first n rows point at a closed port (probe fails → preflight skips them)
    ///   POISON_EMPTY   — the next n rows serve a valid but segmentless playlist (probe passes,
    ///                    mpv never paints → the first-frame watchdog has to deal with them)
    private func poisonRowsIfRequested() {
        let env = ProcessInfo.processInfo.environment
        let refused = Int(env["POISON_REFUSED"] ?? "") ?? 0
        let empty = Int(env["POISON_EMPTY"] ?? "") ?? 0
        guard refused > 0 || empty > 0 else { return }
        for i in streams.indices {
            if i < refused {
                streams[i].url = "http://127.0.0.1:9/refused-\(i).m3u8"
            } else if i >= refused && i < refused + empty {
                // Unique path per row — the drawer keys rows by provider+url, and three
                // identical URLs collapse into one identity (and one checkmark).
                streams[i].url = "http://127.0.0.1:8687/poison-\(i).m3u8"
            }
        }
        MPVController.log("POISON applied: \(refused) refused + \(empty) empty-playlist rows")
    }

    /// AUTOPLAY=1 opens Backrooms on 4khdhub and plays the first row with no clicks, so a
    /// headless run can reproduce a playback path. Verification knobs:
    ///   AUTOPLAY_TYPE=series AUTOPLAY_ID=1399 AUTOPLAY_SEASON=1 AUTOPLAY_EPISODE=1
    ///   AUTOPLAY_MODE=All           use the aggregate live feed instead of the provider-direct route
    ///   EPISODE_NEXT_AFTER=<sec>  presses ] (next episode / season boundary) mid-playback
    ///   MINI_AFTER=<sec>          backs out of the player to the mini-player
    ///   EXPAND_AFTER=<sec>        returns from the mini-player to the full player
    ///   STREAMS_AFTER=<sec>       opens the streams drawer over the player
    ///   RESUME_FIRST=1            launches into the player via Continue Watching resume
    /// OPEN_DETAIL=1 (without AUTOPLAY) opens the hero page without playing — screenshot hook.
    func autoTestIfRequested() {
        let env = ProcessInfo.processInfo.environment
        if env["RESUME_FIRST"] != nil, let first = store.items.first {
            MPVController.log("RESUME_FIRST: \(first.key) @\(Int(first.position))s")
            resume(first)
            return
        }
        if env["AUTOPLAY"] == nil, env["OPEN_DETAIL"] != nil {
            providerMode = .fourk
            section = .discover
            let type = env["OPEN_DETAIL_TYPE"] == "series" ? "series" : "movie"
            let id = Int(env["OPEN_DETAIL_ID"] ?? "") ?? 1083381
            openById(type: type, id: id, season: nil, episode: nil)
            return
        }
        guard env["AUTOPLAY"] != nil else { return }
        // AUTOPLAY_MODE=4khdhub|anime|All picks the fetch path — provider-direct JSON vs the
        // aggregate live feed (which is the one carrying the link-checked `done` payload).
        // Default stays 4khdhub, the app's default provider.
        providerMode = env["AUTOPLAY_MODE"].flatMap(ProviderMode.init(rawValue:)) ?? .fourk
        section = .discover
        let type = env["AUTOPLAY_TYPE"] == "series" ? "series" : "movie"
        let id = Int(env["AUTOPLAY_ID"] ?? "") ?? 1083381
        openById(type: type, id: id,
                 season: Int(env["AUTOPLAY_SEASON"] ?? ""),
                 episode: Int(env["AUTOPLAY_EPISODE"] ?? ""))
        Task { [weak self] in
            guard let self else { return }
            // Wait for the detail load's stream fetch, then play with no further clicks.
            var waited = 0
            while streams.isEmpty, streamsError == nil, waited < 120 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                waited += 1
            }
            poisonRowsIfRequested()
            if !streams.isEmpty {
                // Same path a real press takes: preflight picks the first live row. Hold the
                // snapshot so a live-feed row swap mid-proflight can't mix poisoned picks
                // with unpoisoned rows inside the player.
                let snap = streams
                let best = await preflight(snap)
                playback.start(best, rows: snap, context: makeContext())
                if let secs = Double(env["MINI_AFTER"] ?? "") {
                    try? await Task.sleep(nanoseconds: UInt64(secs * 1_000_000_000))
                    playback.dismissToMini()
                    MPVController.log("MINI_AFTER fired — mode=\(playback.mode)")
                }
                if let secs = Double(env["EXPAND_AFTER"] ?? "") {
                    try? await Task.sleep(nanoseconds: UInt64(secs * 1_000_000_000))
                    playback.mode = .watching
                    MPVController.log("EXPAND_AFTER fired — mode=\(playback.mode)")
                }
                if let secs = Double(env["STREAMS_AFTER"] ?? "") {
                    try? await Task.sleep(nanoseconds: UInt64(secs * 1_000_000_000))
                    playback.showStreams = true
                    MPVController.log("STREAMS_AFTER fired — drawer open")
                }
                if let secs = Double(env["EPISODE_NEXT_AFTER"] ?? "") {
                    try? await Task.sleep(nanoseconds: UInt64(secs * 1_000_000_000))
                    let ok = await advanceEpisode(1)
                    MPVController.log("EPISODE_NEXT_AFTER fired — advanceEpisode(1) -> \(ok)")
                }
            }
        }
    }
}
