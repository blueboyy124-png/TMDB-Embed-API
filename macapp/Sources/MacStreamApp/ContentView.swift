import SwiftUI
import AppKit

// The app shell. Browsing (sidebar + navigation stack) fills the window; the player surface
// sits on top of it at the ROOT of the window content and covers everything while watching.
//
// The surface is mounted in ONE structural position for its whole life and only its frame
// changes between full-window and mini-player, so switching modes never re-creates the
// NSViewRepresentable (which would tear mpv down mid-playback). Root placement is also
// load-bearing for attachment: a representable nested inside NavigationSplitView's detail
// column never receives a window.
struct ContentView: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var pb: PlaybackController
    @State private var keyMonitor: Any?

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Color.black.ignoresSafeArea()

            NavigationSplitView {
                sidebar
                    .navigationSplitViewColumnWidth(min: 170, ideal: 195)
            } detail: {
                NavigationStack(path: $app.path) {
                    root
                        .navigationDestination(for: TitleRef.self) { ref in
                            TitleDetailView(ref: ref)
                        }
                }
            }
            .opacity(pb.mode == .watching ? 0 : 1)
            .allowsHitTesting(pb.mode != .watching)

            if pb.mode != .idle {
                PlayerSurface()
                    .transition(.opacity)
            }
        }
        .preferredColorScheme(.dark)
        .tint(.white)
        .background(WindowConfigurator())
        .onAppear {
            installKeys()
            MPVController.log("ContentView onAppear (monitor \(keyMonitor == nil ? "MISSING" : "ok"))")
            app.autoTestIfRequested()
        }
        .onDisappear { removeKeys() }
    }

    // MARK: sidebar

    private var sidebar: some View {
        List(selection: Binding(
            get: { app.section },
            set: { new in
                if let new, new != app.section {
                    app.section = new
                    app.path = []
                }
            }
        )) {
            ForEach([AppModel.Section.discover, .search], id: \.self) { s in
                Label(s.title, systemImage: s.icon).tag(s)
            }
            Spacer()
            Label(AppModel.Section.settings.title, systemImage: AppModel.Section.settings.icon)
                .tag(AppModel.Section.settings)
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(Color.black)
    }

    // MARK: content root

    @ViewBuilder private var root: some View {
        switch app.section {
        case .discover: DiscoverView()
        case .search: SearchView()
        case .settings: SettingsView()
        }
    }

    // MARK: keyboard

    /// One local key monitor for the whole app. Scope rules:
    ///  - only while something is playing (there is nothing to control otherwise)
    ///  - Command combos always pass through (system/menu shortcuts)
    ///  - when a text field, slider, table or button has focus, ALL keys pass through —
    ///    typing "m" in the server field must type "m", arrow keys belong to the focused
    ///    list, Space belongs to the focused button.
    ///  - otherwise the player keys apply
    private func installKeys() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak app, weak pb] event in
            guard let app, let pb else { return event }
            return handle(event, app: app, pb: pb)
        }
    }

    private func removeKeys() {
        if let m = keyMonitor { NSEvent.removeMonitor(m) }
        keyMonitor = nil
    }

    private func handle(_ e: NSEvent, app: AppModel, pb: PlaybackController) -> NSEvent? {
        MPVController.log("key: code=\(e.keyCode) chars=\(e.charactersIgnoringModifiers ?? "?") mode=\(pb.mode)")
        if e.modifierFlags.contains(.command) { return e }
        if pb.mode == .idle { return e }

        // While WATCHING, the browsing UI below is hidden (opacity 0, hit-testing off) — its
        // focused responder must not swallow player keys. While MINI, browsing is live: keys
        // that belong to a focused field/list/button pass through.
        if pb.mode == .mini,
           let fr = NSApp.keyWindow?.firstResponder,
           fr is NSTextView || fr is NSSlider || fr is NSTableView
            || fr is NSButton || fr is NSCollectionView || fr is NSPopUpButton {
            return e
        }

        switch e.keyCode {
        case 49:                                    // Space
            pb.togglePlay()
            return nil
        case 123:                                   // Left
            pb.seek(by: e.modifierFlags.contains(.shift) ? -60 : -10)
            return nil
        case 124:                                   // Right
            pb.seek(by: e.modifierFlags.contains(.shift) ? 60 : 10)
            return nil
        case 126:                                   // Up — previous row
            pb.switchRowRelative(-1)
            return nil
        case 125:                                   // Down — next row
            pb.switchRowRelative(1)
            return nil
        case 53:                                    // Escape
            if pb.stallOffer != nil { pb.dismissStallOffer(); return nil }
            // Watching -> shrink to the mini-player (video keeps playing).
            // Mini-player -> stop for real (position saved to Continue Watching).
            if pb.mode == .watching { pb.dismissToMini(); return nil }
            if pb.mode == .mini { pb.closeMini(); return nil }
            return e
        case 36:                                    // Return
            if pb.stallOffer != nil { pb.acceptStallOffer(); return nil }
            return e
        default:
            break
        }

        switch e.charactersIgnoringModifiers ?? "" {
        case "[":
            Task { _ = await app.advanceEpisode(-1) }
            return nil
        case "]":
            Task { _ = await app.advanceEpisode(1) }
            return nil
        case "m":
            pb.toggleMute()
            return nil
        case "s":
            pb.showStreams.toggle()
            return nil
        case "?":
            pb.showKeysHelp.toggle()
            return nil
        case "1"..."9":
            if let n = Int(e.charactersIgnoringModifiers ?? "") {
                pb.switchRow(to: n - 1)
                return nil
            }
            return e
        default:
            return e
        }
    }
}

/// Puts the window itself into the theme: true-black background, transparent titlebar so the
/// hero art can run under it, hidden title (the sidebar carries navigation identity).
private struct WindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async { Self.apply(v.window) }
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { Self.apply(nsView.window) }
    }
    private static func apply(_ w: NSWindow?) {
        guard let w, w.backgroundColor != .black else { return }
        w.backgroundColor = .black
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
    }
}
