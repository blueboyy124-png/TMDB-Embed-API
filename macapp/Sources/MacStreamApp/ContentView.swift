import SwiftUI
import AVKit

@main
struct MacStreamApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("Stream Test") {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 1080, minHeight: 700)
        }
        .windowResizability(.contentMinSize)
        .commands { CommandGroup(replacing: .newItem) { } }
    }
}

// MARK: - State

@MainActor
final class AppModel: ObservableObject {
    enum Kind: String, CaseIterable, Identifiable {
        case series = "TV / Anime"
        case movie = "Movie"
        var id: String { rawValue }
        var apiValue: String { self == .movie ? "movie" : "series" }
    }
    /// 4khdhub is the default: it covers anime, TV and movies in high quality, and
    /// asking one provider directly skips the aggregate wait entirely.
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

    @Published var kind: Kind = .series
    @Published var providerMode: ProviderMode = .fourk
    @Published var tmdbId: String = "37854"
    @Published var season: String = "21"
    @Published var episode: String = "1"
    @Published var server: String = "http://127.0.0.1:8787"

    @Published var isLoading = false
    @Published var errorText: String?
    @Published var elapsedMs: Int?
    @Published var response: StreamsResponse?

    @Published var searchQuery = ""
    @Published var searchResults: [SearchResult] = []
    @Published var isSearching = false

    @Published var episodes: [Episode] = []
    @Published var episodesTitle: String = ""
    @Published var isLoadingEpisodes = false

    @Published var playing: Stream?
    /// Streams from the last provider-direct (single-provider) request. The live
    /// feed owns the aggregate path; this owns the 4khdhub/anime path.
    @Published var directStreams: [Stream] = []
    /// The embedded mpv controller, set when the player view attaches. Drives the
    /// custom transport bar and is what makes switching streams work.
    @Published var player: MPVController?
    @Published var pos: Double = 0
    @Published var dur: Double = 0
    @Published var scrubbing = false
    /// Shown when picture data stops arriving while the player is meant to be playing.
    @Published var stallText: String?
    private var lastPos = -1.0
    private var lastMove = Date()
    private var poll: Timer?

    func fmt(_ t: Double) -> String {
        guard t.isFinite, t >= 0 else { return "0:00" }
        let i = Int(t)
        return "\(i / 60):\(String(format: "%02d", i % 60))"
    }

    func startPolling() {
        poll?.invalidate()
        poll = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    func stopPolling() { poll?.invalidate(); poll = nil }

    /// Escapes a stuck stream: releases our hold on the player (which destroys the
    /// mpv handle) and removes the view, so a wedged load can never trap the UI.
    func stopPlayback() {
        stopPolling()
        player?.shutdown()
        player = nil
        playing = nil
        isVideoPlaying = true
        pos = 0; dur = 0
        stallText = nil
        lastPos = -1
    }

    private func tick() {
        // Self-test hooks (headless runs only):
        //   STOP_AFTER=<sec>  presses Stop for us, so the teardown path -- render
        //                     context free + mpv destroy, both off-main -- gets
        //                     exercised without needing to click.
        //   RELOAD_AFTER=<sec> calls load() again instead, which stops playback
        //                     and then rebuilds the whole player (new controller,
        //                     new view attach, new mpv handle) and replays. That
        //                     is the Stop-then-Play-again path users take.
        if let secs = ProcessInfo.processInfo.environment["STOP_AFTER"].flatMap({ Double($0) }),
           let deadline = testDeadline {
            if Date() >= deadline {
                testDeadline = nil
                if ProcessInfo.processInfo.environment["RELOAD_AFTER"] != nil {
                    MPVController.log("RELOAD_AFTER fired — full stop + rebuild")
                    load()
                } else if ProcessInfo.processInfo.environment["SWITCH_AFTER"] != nil {
                    // Mid-playback switch: a different row on the SAME player. No
                    // teardown, no new controller -- just loadfile on the running core.
                    guard directStreams.count > 1 else {
                        MPVController.log("SWITCH_AFTER: only \(directStreams.count) stream(s), nothing to switch to")
                        return
                    }
                    MPVController.log("SWITCH_AFTER fired — switching to stream #2 on the running player")
                    play(directStreams[1])
                } else {
                    MPVController.log("STOP_AFTER fired — stopping playback")
                    stopPlayback()
                }
            }
        }
        guard player != nil, !scrubbing else { return }
        // Async: reading mpv properties touches the same internal lock that wedged
        // the main thread, so it happens off-main and publishes back here.
        player?.readPosition { [weak self] t, d in
            guard let self else { return }
            pos = t.isFinite ? t : 0
            if d > 0 { dur = d }
            if pos > 0.5 && !didLogFirstFrame {
                didLogFirstFrame = true
                MPVController.log("first frame at pos=\(pos)")
            }
            // Stall watch: picture started but no progress for 15s while meant to be
            // playing means the source stopped sending usable data (not a stuck UI --
            // the UI is alive, which is why this message can appear at all).
            if pos != lastPos { lastPos = pos; lastMove = Date(); if stallText != nil { stallText = nil } }
            else if didLogFirstFrame && isVideoPlaying && stallText == nil && Date().timeIntervalSince(lastMove) > 15 {
                stallText = "No picture data for 15s — the source stalled. Press Stop and try another row."
                MPVController.log("STALL detected at pos=\(pos)")
            }
        }
    }
    private var didLogFirstFrame = false
    /// When the STOP_AFTER self-test hook should fire (nil outside a test run).
    private var testDeadline: Date?
    /// Transport state for the embedded player.
    @Published var isVideoPlaying = true
    /// Whether libmpv is present to render into the view. The library is linked at build time, so this only
    /// checks that the runtime dylib is actually loadable.
    let mpvEmbedded = true

    let mpv = MPVRunner()
    /// Live feed. Streams land as each provider settles, so the list is usable almost immediately and keeps
    /// filling in -- including the 4K provider that takes ~12s, arriving while you are already watching.
    let live = LiveStreamFeed()

    // Kept so a new request can invalidate an in-flight one. Task cancellation alone is not enough:
    // the aggregate endpoint can take 20s and the LAST request must win, not the fastest.

    var showEpisodeFields: Bool { kind == .series }

    struct Check: Identifiable {
        let id = UUID()
        let label: String
        let ok: Bool?      // nil = not applicable (a movie has no episode)
    }

    /// The "did it have all its data" answer, computed from the response rather than from what
    /// happened to render -- so a gap in the API shows up as a gap instead of as a blank panel.
    var checks: [Check] {
        let m = response?.metadata
        let ep = m?.episode ?? response?.episode
        func nonEmpty(_ s: String?) -> Bool { !(s ?? "").isEmpty }
        return [
            Check(label: "title", ok: nonEmpty(ep?.name ?? response?.title)),
            Check(label: "description", ok: nonEmpty(ep?.overview ?? response?.overview)),
            Check(label: "still / poster", ok: (ep?.still ?? response?.poster_path) != nil),
            Check(label: "air / release date", ok: (ep?.airDate ?? response?.release_date) != nil),
            Check(label: "absolute episode", ok: kind == .movie ? nil : (ep?.absoluteEpisode != nil)),
            Check(label: "tagged", ok: !(response?.tagCounts ?? [:]).isEmpty),
            Check(label: "AniList cross-ref", ok: kind == .movie ? nil : (m?.anilist?.id != nil))
        ]
    }

    var streams: [Stream] { providerMode == .all ? live.arrived : directStreams }
    var playable: [Stream] { streams.filter { $0.playableInBrowser != false } }

    /// Sources that answered. More than one is what makes a title reliable, so a single source is
    /// called out rather than left for the viewer to notice on their own.
    var sourceBreakdown: [(String, Int)] {
        var counts: [String: Int] = [:]
        for s in streams { counts[s.provider ?? "?" , default: 0] += 1 }
        return counts.sorted { $0.value > $1.value }
    }

    var needsMPV: [Stream] { streams.filter { !$0.nativePlayable } }
    var mpvMissingCount: Int { needsMPV.filter { _ in !mpv.isAvailable }.count }
    // MARK: actions

    func load() {
        API.base = server
        errorText = nil
        response = nil
        elapsedMs = nil
        stopPlayback()
        directStreams = []
        isVideoPlaying = true
        mpv.stop()
        guard let id = Int(tmdbId), id > 0 else {
            errorText = "TMDB ID must be a positive number"
            return
        }
        let type = kind.apiValue
        var s: Int? = nil, e: Int? = nil
        if kind != .movie {
            guard let ss = Int(season), ss >= 0, let ee = Int(episode), ee >= 1 else {
                errorText = "Season must be 0 or more, episode 1 or more"
                return
            }
            s = ss; e = ee
        }
        if let api = providerMode.apiName {
            // Single provider, one JSON round trip -- no aggregate wait, no live feed.
            live.cancel()
            isLoading = true
            Task { [weak self] in
                guard let self else { return }
                let t0 = Date()
                do {
                    let r = try await API.providerStreams(provider: api, type: type, id: id, season: s, episode: e)
                    let ms = r.providerTimings?.values.first ?? Int(Date().timeIntervalSince(t0) * 1000)
                    directStreams = (r.streams ?? []).map { $0.derived().withArrival(ms) }
                    response = r
                    elapsedMs = Int(Date().timeIntervalSince(t0) * 1000)
                    if directStreams.isEmpty { errorText = "\(api) returned no streams for this title" }
                    else if ProcessInfo.processInfo.environment["AUTOPLAY"] != nil {
                        play(directStreams[0])
                    }
                } catch {
                    errorText = error.localizedDescription
                }
                isLoading = false
            }
            return
        }
        if kind == .movie {
            live.start(type: "movie", id: id, season: nil, episode: nil, server: server)
        } else {
            live.start(type: "series", id: id, season: s, episode: e, server: server)
        }
    }

    func loadEpisodes() {
        guard kind == .series, let id = Int(tmdbId), id > 0 else { return }
        API.base = server
        isLoadingEpisodes = true
        Task { [weak self] in
            guard let self else { return }
            do {
                let r = try await API.episodes(type: "series", id: id, season: Int(season) ?? 1)
                episodes = r.episodes ?? []
                episodesTitle = r.title ?? ""
            } catch {
                errorText = error.localizedDescription
            }
            isLoadingEpisodes = false
        }
    }

    func doSearch() {
        let q = searchQuery.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        API.base = server
        isSearching = true
        Task { [weak self] in
            guard let self else { return }
            do {
                let r = try await API.search(q)
                searchResults = r.results ?? []
                if searchResults.isEmpty { errorText = "Nothing found for “\(q)”" }
            } catch {
                errorText = error.localizedDescription
            }
            isSearching = false
        }
    }

    func pick(_ r: SearchResult) {
        tmdbId = String(r.id)
        kind = r.isMovie ? .movie : .series
        if !r.isMovie { season = "1"; episode = "1"; episodes = [] }
        load()
    }

    func play(_ s: Stream) {
        playing = s
        didLogFirstFrame = false
        MPVController.log("play selected: \(s.displayTitle.prefix(60))")
        isVideoPlaying = true
        // Re-arm the STOP_AFTER / RELOAD_AFTER test clock each time playback starts,
        // so every playback cycle gets its own stop (and a RELOAD run cycles).
        testDeadline = ProcessInfo.processInfo.environment["STOP_AFTER"].flatMap { secs in
            Double(secs).map { Date().addingTimeInterval($0) }
        }
    }

    /// Self-test hook: AUTOPLAY=1 loads Backrooms on 4khdhub and plays the first row
    /// with no clicks, so a headless run can reproduce a playback freeze.
    func autoTestIfRequested() {
        guard ProcessInfo.processInfo.environment["AUTOPLAY"] != nil else { return }
        kind = .movie
        providerMode = .fourk
        tmdbId = "1083381"
        load()
    }
}

// MARK: - UI

struct ContentView: View {
    @EnvironmentObject var m: AppModel

    var body: some View {
        HSplitView {
            left.frame(minWidth: 420, idealWidth: 460)
            right.frame(minWidth: 560)
        }
        .onAppear { m.autoTestIfRequested() }
    }

    // MARK: left — what to test, and what came back

    private var left: some View {
        VStack(alignment: .leading, spacing: 14) {
            GroupBox("Server") {
                HStack {
                    TextField("http://127.0.0.1:8787", text: $m.server)
                        .textFieldStyle(.roundedBorder)
                    Button("Go") { m.load() }.keyboardShortcut(.return)
                }
                Text(m.mpv.installHint)
                    .font(.caption)
                    .foregroundStyle(m.mpv.isAvailable ? Color.secondary : Color.orange)
            }

            GroupBox("What to test") {
                VStack(alignment: .leading, spacing: 8) {
                    Picker("Type", selection: $m.kind) {
                        ForEach(AppModel.Kind.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)

                    Picker("Provider", selection: $m.providerMode) {
                        ForEach(AppModel.ProviderMode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)

                    HStack {
                        TextField("TMDB ID", text: $m.tmdbId).textFieldStyle(.roundedBorder)
                        if m.showEpisodeFields {
                            TextField("S", text: $m.season).frame(width: 52).textFieldStyle(.roundedBorder)
                            TextField("E", text: $m.episode).frame(width: 52).textFieldStyle(.roundedBorder)
                            Button("Episodes") { m.loadEpisodes() }
                        }
                    }

                    HStack {
                        TextField("Search titles…", text: $m.searchQuery)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { m.doSearch() }
                        Button("Search") { m.doSearch() }
                    }

                    if !m.searchResults.isEmpty {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 2) {
                                ForEach(m.searchResults.prefix(12)) { r in
                                    Button { m.pick(r) } label: {
                                        HStack {
                                            Text(r.title).lineLimit(1)
                                            Spacer()
                                            Text(r.isMovie ? "movie" : "series")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                    }.buttonStyle(.plain)
                                }
                            }
                        }
                        .frame(height: 140)
                    }
                }
            }

            verdict.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
    }

    /// Speed, sources and completeness — the three things the web test-player answers, in one panel.
    private var verdict: some View {
        GroupBox("Result") {
            VStack(alignment: .leading, spacing: 8) {
                if m.isLoading { ProgressView("Loading streams…") }
                if let e = m.errorText {
                    Text(e).foregroundStyle(.red).textSelection(.enabled)
                }
                if let ms = m.elapsedMs {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(ms)").font(.system(size: 34, weight: .bold))
                        Text("ms total").foregroundStyle(.secondary)
                        if let stop = m.response?.stopReason {
                            Text("· stopped: \(stop)").foregroundStyle(.secondary).font(.caption)
                        }
                    }
                    if let p = m.response?.pending, !p.isEmpty {
                        Text("still working: \(p.joined(separator: ", "))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if m.response != nil { checksRow; sourcesRow }
            }
            .padding(.vertical, 4)
        }
    }

    private var checksRow: some View {
        HStack(spacing: 4) {
            ForEach(m.checks) { c in
                Text(c.ok == nil ? "· \(c.label)" : (c.ok! ? "✓ \(c.label)" : "✕ \(c.label)"))
                    .font(.caption2)
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .background(
                        c.ok == nil ? Color.secondary.opacity(0.15)
                            : (c.ok! ? Color.green.opacity(0.2) : Color.orange.opacity(0.25)),
                        in: Capsule()
                    )
            }
        }
    }

    @ViewBuilder private var sourcesRow: some View {
        let sources = m.sourceBreakdown
        VStack(alignment: .leading, spacing: 2) {
            Text("\(m.playable.count) playable · \(sources.count) source\(sources.count == 1 ? "" : "s")")
                .font(.callout)
            Text(sources.map { "\($0.0)×\($0.1)" }.joined(separator: ", "))
                .font(.caption).foregroundStyle(.secondary)
            if sources.count == 1, let only = sources.first {
                Text("⚠ single source (\(only.0)) — no redundancy if it goes down")
                    .font(.caption).foregroundStyle(.orange)
            }
            if m.mpvMissingCount > 0 {
                Text("\(m.mpvMissingCount) stream(s) need mpv (MKV / 4K) — brew install mpv")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
    }
// MARK: right — playback and the stream list

    private var right: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let s = m.playing { nowPlaying(s) }

            if !m.episodes.isEmpty {
                GroupBox("Episodes — \(m.episodesTitle)") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(m.episodes.prefix(30)) { e in
                                Button(e.label) {
                                    m.season = String(e.seasonNumber ?? 1)
                                    m.episode = String(e.episodeNumber ?? 1)
                                    m.load()
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }.frame(height: 34)
                }
            }

            GroupBox("Streams") {
                List(m.streams) { s in
                    HStack {
                        Button("Play") { m.play(s) }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(s.displayTitle).lineLimit(1)
                            // Arrival time: how far into the request this source finished. Seeing "+2.5s" next
                            // to showbox and "+12.1s" next to 4khdhub explains the whole shape of a request.
                            Text("+\(String(format: "%.1f", Double(s.arrivalMs) / 1000))s")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(s.quality ?? "?").monospacedDigit()
                        Text(s.provider ?? "?").frame(width: 100, alignment: .leading)
                        Text(s.container ?? "?").frame(width: 46, alignment: .leading)
                            .foregroundStyle(s.container == "mkv" ? Color.orange : Color.secondary)
                        if s.languageLabel != nil { Text(s.languageLabel!).frame(width: 76, alignment: .leading) }
                    }
                }
                // The header counts what has arrived so far rather than a final total, so it visibly grows.
                .overlay(alignment: .topTrailing) {
                    if m.live.isLoading {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text("\(m.streams.count) so far…")
                        }
                        .font(.caption).padding(8)
                    }
                }
            }
        }
        .padding(14)
    }

    @ViewBuilder private func nowPlaying(_ s: Stream) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(s.displayTitle).font(.headline)
                Spacer()
                if m.player != nil && m.pos <= 0 && m.isVideoPlaying {
                    ProgressView().controlSize(.small).help("Buffering…")
                }
                Button {
                    m.stopPlayback()
                } label: {
                    Image(systemName: "stop.fill").padding(4)
                }
                .buttonStyle(.borderless)
                .help("Stop")
                Button {
                    toggleFullscreen()
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").padding(4)
                }
                .buttonStyle(.borderless)
                .help("Fullscreen")
            }
            Text("\(s.provider ?? "?") · \(s.quality ?? "?") · \(s.container ?? "?") · \(s.languageLabel ?? "language unknown")")
                .font(.caption).foregroundStyle(.secondary)
            if let st = m.stallText {
                Text(st).font(.caption).foregroundStyle(.orange)
            }

            if m.mpvEmbedded {
                // One player for everything: HLS, MP4 and MKV alike, inline in this window.
                //
                // No system framework decodes Matroska, and every 4K stream this API returns is an MKV, so
                // the previous AVPlayer/subprocess split meant "inline" and "plays 4K" could not both be true.
                // mpv is bound to this view instead, which makes them the same thing.
                MPVView(url: s.url, isPlaying: $m.isVideoPlaying, onReady: { m.player = $0; m.startPolling() })
                    .frame(height: 340)
                    .background(Color.black)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                transportBar
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.secondary.opacity(0.12))
                    .frame(height: 130)
                    .overlay(
                        Text("mpv is not installed, so nothing can play this\nbrew install mpv")
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                    )
            }
        }
    }

    /// Custom transport bar for the embedded player: play/pause, seek, ±10s.
    /// Wired to the mpv controller (not the list selection), so it keeps working
    /// when you switch streams mid-playback.
    private var transportBar: some View {
        HStack(spacing: 8) {
            Button {
                m.isVideoPlaying.toggle()
            } label: {
                Image(systemName: m.isVideoPlaying ? "pause.fill" : "play.fill")
            }
            .buttonStyle(.borderless)
            .help(m.isVideoPlaying ? "Pause" : "Play")
            .disabled(m.player == nil)

            Text(m.fmt(m.pos)).font(.caption).monospacedDigit().frame(width: 44, alignment: .trailing)
            Slider(value: $m.pos, in: 0...max(m.dur, 1), onEditingChanged: { editing in
                m.scrubbing = editing
                if !editing { m.player?.seek(to: m.pos) }
            })
            .disabled(m.player == nil || m.dur <= 0)
            Text(m.fmt(m.dur)).font(.caption).monospacedDigit().frame(width: 44)

            Button("−10") { m.player?.seekBy(-10) }.buttonStyle(.borderless).disabled(m.player == nil)
            Button("+10") { m.player?.seekBy(10) }.buttonStyle(.borderless).disabled(m.player == nil)
        }
        .font(.caption)
    }

    /// Fullscreen for the video pane.
    ///
    /// Enlarges the window and hides the chrome rather than asking mpv to go fullscreen on the whole screen:
    /// the point is watching the picture bigger, and taking over the entire display breaks the sense of an
    /// app with a list you can come back to.
    private func toggleFullscreen() {
        guard let window = NSApp.windows.first else { return }
        window.toggleFullScreen(nil)
    }
}