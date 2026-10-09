import SwiftUI
import AppKit

// The in-app custom stream player: mpv inline at the top, our own transport bar, the row
// selector, and the stall offer. Stays mounted while you keep browsing below it — there is
// deliberately no second window.
struct PlayerPane: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var pb: PlaybackController

    var body: some View {
        VStack(spacing: 6) {
            header
            videoArea
            transport
            if !pb.rows.isEmpty { rowStrip }
        }
        .padding(10)
        .background(.bar)
        .onAppear { MPVController.log("PlayerPane appeared (current=\(pb.current != nil))") }
        .onDisappear { MPVController.log("PlayerPane DISAPPEARED") }
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(app.playback.context?.title ?? "Now playing")
                    .font(.headline)
                    .lineLimit(1)
                if let sub = app.playback.context?.subtitle {
                    Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            if let s = pb.current {
                Text(s.provider ?? "?")
                    .font(.caption2).padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(Color.accentColor.opacity(0.18)))
                Text(s.quality ?? "?").font(.caption2).foregroundStyle(.secondary)
                if let l = s.languageLabel { Text(l).font(.caption2).foregroundStyle(.secondary) }
            }
            Spacer()

            // Episode step: only meaningful for a series with a next/prev to go to.
            if app.detailRef?.type == "series" {
                Button { Task { _ = await app.advanceEpisode(-1) } } label: {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.borderless)
                .help("Previous episode ( [ )")
                .disabled(!app.canAdvanceEpisode(-1))
                Button { Task { _ = await app.advanceEpisode(1) } } label: {
                    Image(systemName: "chevron.right")
                }
                .buttonStyle(.borderless)
                .help("Next episode ( ] )")
                .disabled(!app.canAdvanceEpisode(1))
            }

            Button { pb.showKeysHelp.toggle() } label: {
                Image(systemName: "questionmark.circle")
            }
            .buttonStyle(.borderless)
            .help("Keyboard shortcuts")

            Button { toggleFullscreen() } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
            }
            .buttonStyle(.borderless)
            .help("Fullscreen (f)")

            Button { pb.stop() } label: {
                Image(systemName: "stop.fill")
            }
            .buttonStyle(.borderless)
            .help("Stop (Esc)")
        }
        .font(.callout)
    }

    // MARK: video + overlays

    private var videoArea: some View {
        ZStack {
            if pb.current != nil {
                // One player for everything: HLS, MP4 and MKV alike, inline in this window.
                //
                // No system framework decodes Matroska, and every 4K stream this API returns is
                // an MKV, so an AVPlayer split means "inline" and "plays 4K" cannot both be true.
                // mpv is bound to this view instead, which makes them the same thing. (libmpv is
                // linked at build time — a running app always has it; the mpv *binary* checked in
                // Settings is only the CLI tool.)
                MPVView(url: pb.current?.url, startAt: pb.resumeToken, isPlaying: $pb.isPlaying,
                        onReady: { pb.player = $0; pb.startPolling() })
            }

            // Buffering: mpv attached but no position yet.
            if pb.player != nil && pb.pos <= 0 && pb.isPlaying {
                ProgressView().controlSize(.large)
            }

            if pb.showKeysHelp { keysHelp }

            if pb.stallOffer != nil { stallBanner }
        }
        .frame(height: 290)
        .frame(maxWidth: .infinity)
        .background(Color.black)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    /// The stall OFFER (chosen over auto-switching): the stall is detected for you, the decision
    /// stays yours. Enter switches to the next row, Escape dismisses; the banner also clears
    /// itself if the source recovers.
    private var stallBanner: some View {
        VStack(spacing: 8) {
            Text("No picture data for 15s — the source stalled.")
                .font(.callout.weight(.semibold))
            HStack(spacing: 10) {
                if pb.stallOffer?.canSwitch == true {
                    Button("Switch to next row (⏎)") { pb.acceptStallOffer() }
                        .keyboardShortcut(.return, modifiers: [])
                }
                Button("Dismiss (⎋)") { pb.dismissStallOffer() }
                    .keyboardShortcut(.cancelAction)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .frame(maxWidth: 460)
        .transition(.opacity)
    }

    private var keysHelp: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Keyboard (click the video if another list has focus)").font(.callout.weight(.bold))
            Group {
                Text("Space — play / pause")
                Text("← / → — seek 10s (Shift: 60s)")
                Text("↑ / ↓ — previous / next stream row")
                Text("1…9 — jump to that row")
                Text("[ / ] — previous / next episode")
                Text("f — fullscreen   m — mute")
                Text("⏎ — accept stall offer   Esc — stop")
            }
            .font(.caption)
            Button("Close") { pb.showKeysHelp = false }
                .font(.caption)
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
    }

    // MARK: transport

    private var transport: some View {
        HStack(spacing: 8) {
            Button { pb.togglePlay() } label: {
                Image(systemName: pb.isPlaying ? "pause.fill" : "play.fill")
                    .frame(width: 16)
            }
            .help(pb.isPlaying ? "Pause (Space)" : "Play (Space)")
            .disabled(pb.player == nil)

            Text(pb.fmt(pb.pos)).font(.caption).monospacedDigit().frame(width: 44, alignment: .trailing)
            Slider(value: Binding(
                get: { pb.pos },
                set: { pb.pos = $0 }
            ), in: 0...max(pb.dur, 1), onEditingChanged: { editing in
                pb.scrubbing = editing
                if !editing { pb.player?.seek(to: pb.pos) }
            })
            .disabled(pb.player == nil || pb.dur <= 0)
            Text(pb.fmt(pb.dur)).font(.caption).monospacedDigit().frame(width: 44)

            Button("−10") { pb.seek(by: -10) }.buttonStyle(.borderless).disabled(pb.player == nil)
            Button("+10") { pb.seek(by: 10) }.buttonStyle(.borderless).disabled(pb.player == nil)

            Spacer()

            Button { pb.toggleMute() } label: {
                Image(systemName: pb.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
            }
            .buttonStyle(.borderless)
            .help("Mute (m)")
            Slider(value: Binding(
                get: { pb.volume },
                set: { pb.setVolume($0) }
            ), in: 0...100)
            .frame(width: 90)
            .help("Volume")
        }
        .font(.caption)
    }

    // MARK: row selector

    /// The rows of THIS load, as chips: click or use ↑/↓ / number keys to switch. A switch is a
    /// loadfile on the running player — no teardown — and keeps the current position.
    private var rowStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(pb.rows.enumerated()), id: \.element.id) { index, s in
                    let selected = index == pb.rowIndex
                    Button {
                        pb.switchRow(to: index)
                    } label: {
                        HStack(spacing: 4) {
                            Text("\(index + 1)")
                                .font(.caption2.bold())
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Capsule().fill(selected ? Color.white.opacity(0.25) : Color.secondary.opacity(0.25)))
                            Text("\(s.quality ?? "?") \(s.provider ?? "?")")
                                .font(.caption)
                            if let l = s.languageLabel { Text(l).font(.caption2).foregroundStyle(.secondary) }
                            if s.container == "mkv" { Text("MKV").font(.caption2).foregroundStyle(.orange) }
                        }
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(selected ? Color.accentColor.opacity(0.85) : Color.primary.opacity(0.06))
                        )
                        .foregroundStyle(selected ? Color.white : Color.primary)
                    }
                    .buttonStyle(.plain)
                    .help(s.displayTitle)
                }
            }
        }
        .frame(height: 30)
    }

    private func toggleFullscreen() {
        guard let window = NSApp.windows.first(where: { $0.isVisible }) else { return }
        window.toggleFullScreen(nil)
    }
}
