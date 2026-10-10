import SwiftUI
import AppKit

// Everything about a stream that is currently on screen: the mpv controller, transport state,
// the stall watcher, row switching, and resume. Extracted from AppModel so navigation and
// playback can change independently — you can browse while something plays, and the player
// does not care which section is open.
//
// Threading rule inherited from MPVController: never block main. Position reads hop to the
// mpv queue and publish back; all mpv commands are async.
@MainActor
final class PlaybackController: ObservableObject {
    /// What is playing, as the rest of the app sees it: the title this stream belongs to.
    /// Used for the player header and for Continue Watching records.
    struct Context: Equatable {
        var title: String
        var subtitle: String?
        var poster: String?
        var tmdbId: Int?
        var type: String?          // "movie" | "series"
        var season: Int?
        var episode: Int?
    }

    /// The stall banner's offer. A stall is detected, but the switch is the user's decision —
    /// auto-switching away from a stream that was about to recover is worse than one click.
    struct StallOffer: Equatable {
        var canSwitch: Bool
    }

    /// How playback is presented. `watching` is the full-window player; `mini` is the floating
    /// card while browsing; `idle` is no playback at all. The mpv view lives in ONE persistent
    /// spot in the hierarchy and only its frame changes between modes, so switching
    /// watching <-> mini never re-creates the player (that would tear mpv down mid-playback).
    enum PlayerMode: Equatable {
        case idle, watching, mini
    }

    @Published var mode: PlayerMode = .idle
    /// True while mpv is waiting on the network (cache-idle while meant to be playing) —
    /// the buffering spinner. A paused player is core-idle too, hence `isPlaying`.
    @Published var buffering = false

    @Published var current: Stream?
    @Published var context: Context?
    /// Every row of the last load — the row selector's list. Switching rows is a loadfile on
    /// the running player, not a rebuild.
    @Published var rows: [Stream] = []
    @Published var rowIndex: Int?

    @Published var player: MPVController?
    @Published var pos: Double = 0
    @Published var dur: Double = 0
    @Published var scrubbing = false
    @Published var isPlaying = true
    @Published var volume: Double = 100
    @Published var muted = false

    @Published var stallOffer: StallOffer?
    @Published var showKeysHelp = false
    /// The streams drawer in the player: manual row picking, opt-in (auto-play is the default).
    @Published var showStreams = false

    /// Consumed by MPVView the moment the URL changes: mpv's `start=` per-file option puts the
    /// first frame at this position instead of flashing 0:00 and then jumping. It is rewritten
    /// before every start (new title: saved position; row switch: live position; next episode: 0),
    /// so it never leaks into a later load.
    @Published var resumeToken: Double = 0

    private let store: ContinueStore
    private var poll: Timer?
    private var lastPos = -1.0
    private var lastMove = Date()
    private var didFirstFrame = false
    private var stallDismissed = false
    private var lastSaved = Date.distantPast
    private var tickCount = 0
    private var testDeadline: Date?
    /// Remembered so RELOAD_AFTER can rebuild the exact same playback.
    private var lastStart: (Stream, [Stream], Context, Double)?

    init(store: ContinueStore) {
        self.store = store
    }

    func fmt(_ t: Double) -> String {
        guard t.isFinite, t >= 0 else { return "0:00" }
        let i = Int(t)
        return "\(i / 60):\(String(format: "%02d", i % 60))"
    }

    // MARK: starting / stopping

    /// Starts (or switches into) a stream. If something was already playing, its position is
    /// flushed to Continue Watching first, then the context is replaced.
    // MARK: first-frame watchdog state

    /// When the current row was (re)loaded — the watchdog's clock. Set by start() and
    /// switchRow(); never by the poll.
    private var rowLoadStarted = Date()
    /// Consecutive rows that never produced a picture. Reset on first frame, on a new
    /// selection, and on MANUAL switches (your pick gets its own fresh budget).
    private var startMisses = 0

    /// Transient status line over the player (watchdog progress, give-up message).
    @Published var notice: String?
    private var noticeTask: Task<Void, Never>?

    func notice(_ message: String) {
        MPVController.log("notice: \(message)")
        noticeTask?.cancel()
        notice = message
        noticeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if !Task.isCancelled { self?.notice = nil }
        }
    }

    func start(_ stream: Stream, rows: [Stream], context: Context, resume: Double = 0) {
        flushProgress()
        self.context = context
        self.rows = rows
        self.rowIndex = rows.firstIndex { $0.id == stream.id }
        resumeToken = resume.isFinite && resume > 1 ? resume : 0
        didFirstFrame = false
        stallOffer = nil
        stallDismissed = false
        lastPos = -1
        lastMove = Date()
        rowLoadStarted = Date()
        startMisses = 0
        isPlaying = true
        lastStart = (stream, rows, context, resume)
        MPVController.log("play selected: \(stream.displayTitle.prefix(60))\(resume > 1 ? " @\(Int(resume))s" : "")")
        mode = .watching
        current = stream
        // Self-test clock: every playback cycle gets its own STOP_AFTER window.
        testDeadline = ProcessInfo.processInfo.environment["STOP_AFTER"].flatMap { secs in
            Double(secs).map { Date().addingTimeInterval($0) }
        }
        startPolling()
    }

    /// Escapes a stuck stream: releases the controller (destroying the mpv handle) and removes
    /// the view, so a wedged load can never trap the UI. State clears once the mpv handle is
    /// actually gone (usually well under a second), which also keeps the last frame on screen
    /// during teardown instead of flashing to an empty pane.
    func stop(completion: (() -> Void)? = nil) {
        flushProgress()
        stopPolling()
        if let p = player {
            p.shutdown { [weak self] in
                self?.finishStop()
                completion?()
            }
        } else {
            finishStop()
            if let completion { DispatchQueue.main.async(execute: completion) }
        }
    }

    private func finishStop() {
        player = nil
        current = nil
        mode = .idle
        buffering = false
        context = nil
        rows = []
        rowIndex = nil
        isPlaying = true
        pos = 0; dur = 0
        resumeToken = 0
        stallOffer = nil
        startMisses = 0
        notice = nil
        lastPos = -1
        lastStart = nil
    }

    /// Back out of the full player WITHOUT stopping: the video shrinks to the mini-player card
    /// and keeps playing while you browse. mpv is untouched — only the presentation changes.
    func dismissToMini() {
        guard mode == .watching, current != nil else { return }
        mode = .mini
    }

    /// The mini-player's close button (and Esc from the mini state): stop for real.
    /// Position is saved by the stop path.
    func closeMini() {
        guard mode == .mini else { return }
        stop()
    }

    // MARK: transport

    func togglePlay() {
        guard player != nil else { return }
        isPlaying.toggle()
    }

    func seek(by seconds: Double) {
        player?.seekBy(seconds)
        // The poll would otherwise report the pre-seek position for up to 0.5s and the stall
        // watcher could see "no movement" right after a jump.
        lastMove = Date()
    }

    func setVolume(_ v: Double) {
        volume = min(100, max(0, v))
        player?.command("set volume \(Int(volume))")
        if muted && volume > 0 { muted = false; player?.command("set mute no") }
    }

    func toggleMute() {
        muted.toggle()
        player?.command("set mute \(muted ? "yes" : "no")")
    }

    // MARK: row selector

    /// Switches to another row of the SAME load. Position is carried over (set as the new
    /// resume token), because a row switch — especially a stall-driven one — must not restart
    /// the movie from zero.
    func switchRow(to index: Int, auto: Bool = false) {
        guard rows.indices.contains(index), index != rowIndex else { return }
        resumeToken = pos.isFinite && pos > 2 ? pos : 0
        rowIndex = index
        didFirstFrame = false
        stallOffer = nil
        stallDismissed = false
        lastPos = -1
        lastMove = Date()
        rowLoadStarted = Date()
        if !auto { startMisses = 0 }   // a watchdog advance spends the same budget instead
        isPlaying = true
        lastStart = (rows[index], rows, context ?? lastStart?.2 ?? Context(title: ""), resumeToken)
        MPVController.log("row switch -> #\(index + 1) \(rows[index].displayTitle.prefix(50))")
        current = rows[index]
    }

    func switchRowRelative(_ delta: Int, auto: Bool = false) {
        guard let i = rowIndex else {
            if !rows.isEmpty { switchRow(to: delta > 0 ? 0 : rows.count - 1, auto: auto) }
            return
        }
        let target = i + delta
        guard rows.indices.contains(target) else { return }
        switchRow(to: target, auto: auto)
    }

    /// Re-sync the row list with the live feed, which keeps changing AFTER playback starts:
    /// raw provider rows land in ~2.5s, the link-checked `done` payload supersedes them ~10s
    /// later. A list captured at start() goes stale — the watchdog could exhaust its strikes
    /// against a dead first row while 30 better rows had already arrived. Called on every
    /// arrival; the current row keeps playing, only the list (and the index) refresh.
    func refreshRows(_ with: [Stream]) {
        guard current != nil, !with.isEmpty else { return }
        guard mode == .watching || mode == .mini else { return }
        rows = with
        if let id = current?.id, let idx = with.firstIndex(where: { $0.id == id }) {
            rowIndex = idx
            return
        }
        // Our row vanished from the list — the link-checker dropped it as dead. A row that
        // never painted gets moved off immediately (the check has proof; the drawer would
        // not even offer it). A row that is ALREADY playing is never interrupted: the probe
        // can lie, and an interruption of a working picture is worse than a stale index —
        // switch fallbacks handle rowIndex == nil whenever the user actually switches.
        if !didFirstFrame {
            MPVController.log("refreshRows: current row link-checked out — moving to row 1")
            rowIndex = nil                       // clear the stale index or switchRow's `index != rowIndex` guard can no-op
            switchRow(to: 0, auto: true)
        } else {
            MPVController.log("refreshRows: playing row link-checked out — index unbound, playback continues")
            rowIndex = nil
        }
    }

    // MARK: stall offer

    func acceptStallOffer() {
        guard stallOffer != nil else { return }
        stallOffer = nil
        stallDismissed = true
        switchRowRelative(1)
    }

    func dismissStallOffer() {
        stallOffer = nil
        stallDismissed = true
    }

    // MARK: polling / stall watch / hooks

    func startPolling() {
        poll?.invalidate()
        poll = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    func stopPolling() {
        poll?.invalidate()
        poll = nil
    }

    private func tick() {
        tickCount += 1
        if tickCount % 40 == 0 {
            MPVController.log("tick \(tickCount): pos=\(pos) dur=\(dur) player=\(player != nil) offer=\(stallOffer != nil)")
        }
        // Headless self-test hooks (see README section on verification runs):
        //   STOP_AFTER=<sec>    presses Stop for us (teardown path)
        //   RELOAD_AFTER=<sec>  stop + full rebuild (new controller, new attach)
        //   SWITCH_AFTER=<sec>  mid-playback row switch on the running player
        if let secs = ProcessInfo.processInfo.environment["STOP_AFTER"].flatMap({ Double($0) }),
           let deadline = testDeadline {
            if Date() >= deadline {
                testDeadline = nil
                if ProcessInfo.processInfo.environment["RELOAD_AFTER"] != nil {
                    MPVController.log("RELOAD_AFTER fired — full stop + rebuild")
                    if let (s, r, c, resume) = lastStart {
                        // The replay must land in a LATER render pass than the stop:
                        // SwiftUI has to commit current == nil (pane unmounts, view
                        // dismantled) before the new play remounts it. Replaying in the
                        // same turn coalesces old→nil→new into one change and the fresh
                        // controller never receives a view to attach to.
                        stop { [weak self] in
                            DispatchQueue.main.async {
                                self?.start(s, rows: r, context: c, resume: resume)
                            }
                        }
                    } else {
                        stop()
                    }
                } else if ProcessInfo.processInfo.environment["SWITCH_AFTER"] != nil {
                    MPVController.log("SWITCH_AFTER fired — switching to the next row")
                    switchRowRelative(1)
                } else {
                    MPVController.log("STOP_AFTER fired — stopping playback")
                    stop()
                }
            }
        }
        guard player != nil, !scrubbing else { return }
        // Async: reading mpv properties touches the same internal lock that once wedged main.
        player?.readPosition { [weak self] t, d, coreIdle in
            guard let self else { return }
            pos = t.isFinite ? t : 0
            if d > 0 { dur = d }
            buffering = coreIdle && isPlaying
            if pos > 0.5 && !didFirstFrame {
                didFirstFrame = true
                startMisses = 0
                MPVController.log("first frame at pos=\(pos)")
            }
            // First-frame watchdog: a row that never produces a picture (dead CDN link,
            // expired signature, garbage playlist) is not something buffering can fix —
            // advance instead of spinning on it. Three strikes open the drawer so the
            // choice becomes manual, with the player paused rather than looping forever.
            // The 14s bar is measured, not guessed: proxy-HLS first frames take ~10s
            // (mpv --frames=1 on a checked-clean row: 9.9s end-to-end), so anything
            // under that false-kills rows that WERE about to play — the exact bug class
            // this watchdog exists to prevent, inverted.
            if !didFirstFrame, isPlaying, rowIndex != nil,
               Date().timeIntervalSince(rowLoadStarted) > 14 {
                startMisses += 1
                if startMisses < 3, let i = rowIndex, rows.indices.contains(i + 1) {
                    notice("Row \(i + 1) wouldn't load — trying the next one…")
                    MPVController.log("watchdog: row \(i + 1) never started — advancing (\(startMisses)/3)")
                    switchRow(to: i + 1, auto: true)
                } else {
                    notice("This stream won't load — pick another row")
                    MPVController.log("watchdog: giving up after \(startMisses) dead row(s)")
                    isPlaying = false
                    showStreams = true
                }
            }
            // Stall watch: picture started but no progress for 15s while meant to be playing
            // means the source stopped sending usable data. Never-started rows are the
            // watchdog's job above, not this banner's.
            if pos != lastPos {
                lastPos = pos
                lastMove = Date()
                stallOffer = nil          // recovered on its own
                stallDismissed = false
            } else if didFirstFrame && isPlaying && Date().timeIntervalSince(lastMove) > 15 {
                // End of file is not a stall: pos parked at the duration means the video
                // FINISHED, and offering "switch to the next row" there would be nonsense.
                let atEnd = dur > 0 && pos >= dur - 0.5
                if stallOffer == nil && !stallDismissed && !atEnd {
                    stallOffer = StallOffer(canSwitch: rows.count > 1)
                    MPVController.log("STALL detected at pos=\(pos) (rows=\(rows.count))")
                }
            }
            // Continue Watching: on stop via flushProgress(), plus every 10s while playing —
            // a position saved only on clean exit is a position lost on crash.
            if Date().timeIntervalSince(lastSaved) >= 10 {
                flushProgress()
            }
        }
    }

    /// Writes the current position for the CURRENT context. Call before replacing the context
    /// or tearing playback down.
    private func flushProgress() {
        lastSaved = Date()
        guard let ctx = context, dur > 0, let id = ctx.tmdbId, id > 0 else { return }
        let isSeries = ctx.type == "series"
        let key = isSeries
            ? "series:\(id):s\(ctx.season ?? 1)e\(ctx.episode ?? 1)"
            : "movie:\(id)"
        store.record(ContinueItem(
            key: key,
            tmdbId: id,
            type: ctx.type ?? "movie",
            season: isSeries ? ctx.season : nil,
            episode: isSeries ? ctx.episode : nil,
            title: ctx.title,
            subtitle: ctx.subtitle,
            poster: ctx.poster,
            position: pos,
            duration: dur,
            updatedAt: Date()
        ))
    }
}
