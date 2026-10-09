import SwiftUI
import AppKit

// The app shell: sidebar (Discover / Search / Settings), the player pane pinned above the
// content while something plays, and the navigation stack for title details. The player
// stays mounted across section changes — browsing does not interrupt watching, and there
// is no separate window anywhere.
struct ContentView: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var pb: PlaybackController
    @State private var keyMonitor: Any?

    var body: some View {
        VStack(spacing: 0) {
            // The player lives at the ROOT of the window content, above the split view: an
            // NSViewRepresentable nested inside NavigationSplitView's detail column is created
            // by SwiftUI but never committed to the window's view tree (window == nil forever),
            // while at the root it attaches on the first pass.
            if pb.current != nil {
                PlayerPane()
                Divider()
            }
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
        }
        .onAppear {
            installKeys()
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
    ///  - otherwise the player keys apply (clicking the video puts it in this state)
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
        if e.modifierFlags.contains(.command) { return e }
        if pb.current == nil { return e }

        if let fr = NSApp.keyWindow?.firstResponder,
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
            // In fullscreen, Escape belongs to the system (exit fullscreen).
            if NSApp.windows.contains(where: { $0.styleMask.contains(.fullScreen) }) { return e }
            pb.stop()
            return nil
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
        case "f":
            if let w = NSApp.windows.first(where: { $0.isVisible }) { w.toggleFullScreen(nil) }
            return nil
        case "m":
            pb.toggleMute()
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
