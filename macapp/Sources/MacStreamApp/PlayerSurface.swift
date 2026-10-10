import SwiftUI
import AppKit

// The player surface: the whole window while watching, a floating card in the corner while
// browsing (mini-player). ONE instance of this view exists for the life of a playback — the
// mode only changes its frame, so the embedded mpv view is never re-created by switching.
//
// Controls auto-hide while playing (hover or move the mouse to bring them back), like every
// streaming player. Manual stream picking lives in the Streams drawer (auto-play picks the
// first row; the drawer is the opt-in override).
struct PlayerSurface: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var pb: PlaybackController

    @State private var controlsVisible = true
    @State private var hideTask: Task<Void, Never>?

    var body: some View {
        ZStack {
            // 1. The video — first child, always in the same structural position. Branching
            //    around it would re-create the representable and tear mpv down.
            if pb.current != nil {
                MPVView(url: pb.current?.url, startAt: pb.resumeToken, isPlaying: $pb.isPlaying,
                        onReady: { pb.player = $0; pb.startPolling() })
            }

            // 2. Loading screen: the player has been entered but no stream has arrived yet
            //    (streams are still being fetched), or the fetch failed.
            if pb.mode == .watching, pb.current == nil {
                loadingScreen
            }

            // 3. Watching-mode chrome
            if pb.mode == .watching {
                tapToTogglePlay
                if controlsVisible { topBar }
                if controlsVisible { bottomTransport }
                if pb.buffering { ProgressView().controlSize(.large) }
                if let msg = pb.notice {
                    // Watchdog status ("Row 2 wouldn't load — trying the next one…"): sits
                    // above the transport, doesn't take hits (the video tap owns those).
                    Text(msg)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Capsule().fill(.black.opacity(0.78)))
                        .overlay(Capsule().stroke(.white.opacity(0.18), lineWidth: 1))
                        .frame(maxHeight: .infinity, alignment: .bottom)
                        .padding(.bottom, 100)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
                if pb.showKeysHelp { keysHelp }
                if pb.stallOffer != nil { stallBanner }
                if pb.showStreams { streamsDrawer }
            }

            // 4. Mini-player chrome
            if pb.mode == .mini {
                // Click anywhere on the card (that isn't a button) to go back to full player.
                Color.clear.contentShape(Rectangle())
                    .onTapGesture { pb.mode = .watching; reveal() }
                if controlsVisible { miniBar }
            }
        }
        .frame(
            minWidth: pb.mode == .mini ? 400 : nil,
            maxWidth: pb.mode == .mini ? 400 : .infinity,
            minHeight: pb.mode == .mini ? 225 : nil,
            maxHeight: pb.mode == .mini ? 225 : .infinity,
            alignment: .bottomTrailing
        )
        .offset(x: pb.mode == .mini ? -18 : 0, y: pb.mode == .mini ? -18 : 0)
        .background(Color.black)
        .clipShape(RoundedRectangle(cornerRadius: pb.mode == .mini ? 10 : 0))
        .overlay(
            RoundedRectangle(cornerRadius: pb.mode == .mini ? 10 : 0)
                .stroke(Color.white.opacity(pb.mode == .mini ? 0.15 : 0), lineWidth: 1)
        )
        .shadow(color: .black.opacity(pb.mode == .mini ? 0.6 : 0), radius: pb.mode == .mini ? 12 : 0)
        .onContinuousHover { _ in
            // Any hover activity re-arms the auto-hide timer (which only hides while playing).
            MPVController.log("hover fired (mode=\(pb.mode))")
            reveal()
        }
        .onAppear { reveal() }
        .onChange(of: pb.isPlaying) { v in
            MPVController.log("onChange isPlaying -> \(v)")
            reveal()
        }
        .onChange(of: pb.showStreams) { v in
            MPVController.log("onChange showStreams -> \(v)")
            reveal()
        }
        .onChange(of: pb.showKeysHelp) { _ in reveal() }
        .onChange(of: pb.stallOffer) { _ in reveal() }
        .onDisappear { hideTask?.cancel() }
    }

    // MARK: visibility of controls

    private func reveal() {
        if !controlsVisible {
            MPVController.log("controls reveal -> visible")
        }
        withAnimation(.easeOut(duration: 0.2)) { controlsVisible = true }
        hideTask?.cancel()
        guard pb.isPlaying, !pb.scrubbing, pb.stallOffer == nil,
              !pb.showStreams, !pb.showKeysHelp else { return }
        hideTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_500_000_000)
            if !Task.isCancelled {
                MPVController.log("controls auto-hide")
                withAnimation(.easeIn(duration: 0.3)) { controlsVisible = false }
            }
        }
    }

    // MARK: watching — overlays

    private var tapToTogglePlay: some View {
        Color.clear.contentShape(Rectangle())
            .onTapGesture { pb.togglePlay() }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            Button {
                pb.dismissToMini()
            } label: {
                Image(systemName: "chevron.down").font(.title3)
            }
            .buttonStyle(.borderless)
            .help("Back to browsing — keeps playing (Esc)")

            VStack(alignment: .leading, spacing: 1) {
                Text(pb.context?.title ?? "Now playing")
                    .font(.headline).lineLimit(1)
                if let sub = pb.context?.subtitle {
                    Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            if let s = pb.current {
                Text(s.quality ?? "?").font(.caption2)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(Color.white.opacity(0.12)))
                Text(s.provider ?? "?").font(.caption2).foregroundStyle(.secondary)
                if let l = s.languageLabel {
                    Text(l).font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button { pb.stop() } label: {
                Image(systemName: "xmark").font(.title3)
            }
            .buttonStyle(.borderless)
            .help("Stop and close the player")
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(
            LinearGradient(colors: [.black.opacity(0.7), .clear],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: 110)
                .frame(maxHeight: .infinity, alignment: .top),
            alignment: .top
        )
    }

    private var bottomTransport: some View {
        VStack(spacing: 10) {
            scrubber
            HStack(spacing: 14) {
                Button { pb.togglePlay() } label: {
                    Image(systemName: pb.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title2)
                }
                .buttonStyle(.borderless)
                .help(pb.isPlaying ? "Pause (Space)" : "Play (Space)")
                .disabled(pb.player == nil)

                Button { pb.seek(by: -10) } label: {
                    Image(systemName: "gobackward.10").font(.title3)
                }
                .buttonStyle(.borderless).disabled(pb.player == nil)
                Button { pb.seek(by: 10) } label: {
                    Image(systemName: "goforward.10").font(.title3)
                }
                .buttonStyle(.borderless).disabled(pb.player == nil)

                if app.detailRef?.type == "series" {
                    Button { Task { _ = await app.advanceEpisode(-1) } } label: {
                        Image(systemName: "backward.end.alt").font(.title3)
                    }
                    .buttonStyle(.borderless)
                    .help("Previous episode ( [ )")
                    .disabled(!app.canAdvanceEpisode(-1))
                    Button { Task { _ = await app.advanceEpisode(1) } } label: {
                        Image(systemName: "forward.end.alt").font(.title3)
                    }
                    .buttonStyle(.borderless)
                    .help("Next episode ( ] )")
                    .disabled(!app.canAdvanceEpisode(1))
                }

                Spacer()

                Button { pb.toggleMute() } label: {
                    Image(systemName: pb.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                }
                .buttonStyle(.borderless).help("Mute (m)")
                Slider(value: Binding(
                    get: { pb.volume },
                    set: { pb.setVolume($0) }
                ), in: 0...100)
                .frame(width: 90)

                Button { pb.showStreams.toggle() } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "list.bullet.rectangle")
                        Text("Streams").font(.callout)
                    }
                }
                .buttonStyle(.borderless)
                .help("Pick a stream manually (s)")
                .foregroundStyle(pb.showStreams ? .white : .secondary)

                Button { pb.showKeysHelp.toggle() } label: {
                    Image(systemName: "questionmark.circle")
                }
                .buttonStyle(.borderless)
                .help("Keyboard shortcuts (?)")
            }
            .foregroundStyle(.white)
        }
        .padding(.horizontal, 22)
        .padding(.bottom, 16)
        .frame(maxHeight: .infinity, alignment: .bottom)
        .background(
            LinearGradient(colors: [.clear, .black.opacity(0.85)],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: 160)
                .frame(maxHeight: .infinity, alignment: .bottom),
            alignment: .bottom
        )
    }

    private var scrubber: some View {
        HStack(spacing: 10) {
            Text(pb.fmt(pb.pos)).font(.caption).monospacedDigit()
                .frame(width: 46, alignment: .trailing)
            Slider(value: Binding(
                get: { pb.pos },
                set: { pb.pos = $0 }
            ), in: 0...max(pb.dur, 1), onEditingChanged: { editing in
                pb.scrubbing = editing
                if !editing { pb.player?.seek(to: pb.pos) }
            })
            .disabled(pb.player == nil || pb.dur <= 0)
            Text(pb.fmt(pb.dur)).font(.caption).monospacedDigit()
                .frame(width: 46, alignment: .leading)
        }
        .foregroundStyle(.white.opacity(0.9))
    }

    // MARK: mini-player

    private var miniBar: some View {
        HStack(spacing: 10) {
            Button { pb.togglePlay() } label: {
                Image(systemName: pb.isPlaying ? "pause.fill" : "play.fill")
            }
            .buttonStyle(.borderless)
            Text(pb.context?.title ?? "")
                .font(.caption.weight(.semibold)).lineLimit(1)
            Spacer()
            Button { pb.mode = .watching } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
            }
            .buttonStyle(.borderless)
            .help("Back to full player")
            Button { pb.closeMini() } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .help("Stop playing (position is saved)")
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
        .frame(maxHeight: .infinity, alignment: .bottom)
        .background(
            LinearGradient(colors: [.clear, .black.opacity(0.75)],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: 90)
                .frame(maxHeight: .infinity, alignment: .bottom),
            alignment: .bottom
        )
    }

    // MARK: loading / error screen

    private var loadingScreen: some View {
        VStack(spacing: 14) {
            if let e = app.streamsError, app.streams.isEmpty {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 34)).foregroundStyle(.orange)
                Text("Couldn't start playback").font(.headline)
                Text(e).font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: 480).multilineTextAlignment(.center)
                HStack(spacing: 10) {
                    Button("Retry") { app.playSelected() }
                        .buttonStyle(.borderedProminent)
                    Button("Back to details") { pb.mode = .idle }
                        .buttonStyle(.bordered)
                }
            } else {
                ProgressView().controlSize(.large)
                Text(app.detail?.title ?? pb.context?.title ?? "Loading…")
                    .font(.headline)
                Text("Finding streams…").font(.callout).foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
    }

    // MARK: stall offer

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
        .foregroundStyle(.white)
        .frame(maxWidth: 460)
        .frame(maxHeight: .infinity, alignment: .center)
        .transition(.opacity)
    }

    // MARK: streams drawer

    /// The manual override: every row of this load, current one highlighted. Switching keeps
    /// the position (it is a loadfile on the running player, not a rebuild).
    private var streamsDrawer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Streams").font(.headline)
                Text("\(pb.rows.count)").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button { pb.showStreams = false } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
            }
            .padding(.bottom, 2)

            ScrollView {
                VStack(spacing: 3) {
                    ForEach(Array(pb.rows.enumerated()), id: \.element.id) { index, s in
                        streamRow(index, s)
                    }
                }
            }
        }
        .padding(12)
        .frame(width: 360)
        .frame(maxHeight: .infinity)
        .background(Color.black.opacity(0.94))
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.white.opacity(0.1)).frame(width: 1)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .transition(.move(edge: .trailing))
    }

    private func streamRow(_ index: Int, _ s: Stream) -> some View {
        let selected = index == pb.rowIndex
        return Button {
            pb.switchRow(to: index)
        } label: {
            HStack(spacing: 8) {
                Text("\(index + 1)")
                    .font(.caption2.bold())
                    .frame(width: 22, height: 22)
                    .background(Circle().fill(Color.white.opacity(selected ? 0.3 : 0.12)))
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(s.quality ?? "?").font(.callout.weight(.medium))
                        if let l = s.languageLabel {
                            Text(l).font(.caption2).foregroundStyle(.secondary)
                        }
                        if s.container == "mkv" {
                            Text("MKV").font(.caption2).foregroundStyle(.orange)
                        }
                    }
                    Text("\(s.provider ?? "?")\(s.sourceTitle.map { " · \($0)" } ?? "")")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                if selected {
                    Image(systemName: "checkmark").font(.caption).foregroundStyle(.white)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8)
                .fill(selected ? Color.white.opacity(0.14) : Color.clear))
        }
        .buttonStyle(.plain)
        .help(s.displayTitle)
    }

    // MARK: keys help

    private var keysHelp: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Keyboard").font(.callout.weight(.bold))
            Group {
                Text("Space — play / pause")
                Text("← / → — seek 10s (Shift: 60s)")
                Text("↑ / ↓ — previous / next stream row")
                Text("1…9 — jump to that row")
                Text("s — streams drawer   m — mute")
                Text("[ / ] — previous / next episode")
                Text("⏎ — accept stall offer")
                Text("Esc — back to mini-player, then stop")
            }
            .font(.caption)
            Button("Close") { pb.showKeysHelp = false }
                .font(.caption)
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .foregroundStyle(.white)
        .frame(maxHeight: .infinity, alignment: .center)
    }
}
