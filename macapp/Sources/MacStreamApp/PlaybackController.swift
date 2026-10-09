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
        isPlaying = true
        lastStart = (stream, rows, context, resume)
        MPVController.log("play selected: \(stream.displayTitle.prefix(60))\(resume > 1 ? " @\(Int(resume))s" : "")")
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
        context = nil
        rows = []
        rowIndex = nil
        isPlaying = true
        pos = 0; dur = 0
        resumeToken = 0
        stallOffer = nil
        lastPos = -1
        lastStart = nil
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
    func switchRow(to index: Int) {
        guard rows.indices.contains(index), index != rowIndex else { return }
        resumeToken = pos.isFinite && pos > 2 ? pos : 0
        rowIndex = index
        didFirstFrame = false
        stallOffer = nil
        stallDismissed = false
        lastPos = -1
        lastMove = Date()
        isPlaying = true
        lastStart = (rows[index], rows, context ?? lastStart?.2 ?? Context(title: ""), resumeToken)
        MPVController.log("row switch -> #\(index + 1) \(rows[index].displayTitle.prefix(50))")
        current = rows[index]
    }

    func switchRowRelative(_ delta: Int) {
        guard let i = rowIndex else {
            if !rows.isEmpty { switchRow(to: delta > 0 ? 0 : rows.count - 1) }
            return
        }
        let target = i + delta
        guard rows.indices.contains(target) else { return }
        switchRow(to: target)
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
        player?.readPosition { [weak self] t, d in
            guard let self else { return }
            pos = t.isFinite ? t : 0
            if d > 0 { dur = d }
            if pos > 0.5 && !didFirstFrame {
                didFirstFrame = true
                MPVController.log("first frame at pos=\(pos)")
            }
            // Stall watch: picture started but no progress for 15s while meant to be playing
            // means the source stopped sending usable data.
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
