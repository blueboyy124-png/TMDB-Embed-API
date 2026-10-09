import SwiftUI

@main
struct MacStreamApp: App {
    @StateObject private var model: AppModel
    @StateObject private var playback: PlaybackController

    init() {
        let m = AppModel()
        _model = StateObject(wrappedValue: m)
        // The SAME instance AppModel owns — one playback controller, observed directly, so
        // player state changes publish without routing through AppModel.
        _playback = StateObject(wrappedValue: m.playback)
    }

    var body: some Scene {
        WindowGroup("MacStream") {
            ContentView()
                .environmentObject(model)
                .environmentObject(playback)
                .frame(minWidth: 1080, minHeight: 700)
        }
        .windowResizability(.contentMinSize)
        .commands {
            // No untitled windows: this app is one player, not a document.
            CommandGroup(replacing: .newItem) { }
            CommandMenu("Go") {
                Button("Discover") { go(.discover) }
                    .keyboardShortcut("1", modifiers: [.command])
                Button("Search") { go(.search) }
                    .keyboardShortcut("2", modifiers: [.command])
                Button("Settings") { go(.settings) }
                    .keyboardShortcut("3", modifiers: [.command])
            }
        }
    }

    private func go(_ s: AppModel.Section) {
        model.section = s
        model.path = []
    }
}
