import SwiftUI

// Server address, default provider, the raw-id opener, and maintenance. The server field is
// editable at runtime because the port changes and the app should not need a rebuild.
struct SettingsView: View {
    @EnvironmentObject var app: AppModel

    @State private var openType = "movie"
    @State private var openId = ""
    @State private var openSeason = "1"
    @State private var openEpisode = "1"

    var body: some View {
        Form {
            Section("Server") {
                HStack {
                    TextField("http://127.0.0.1:8787", text: $app.server)
                        .textFieldStyle(.roundedBorder)
                    Button("Reconnect") {
                        app.trending = []
                        app.loadTrendingIfNeeded()
                    }
                }
                Text("The API this app talks to. Applied immediately.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Provider") {
                Picker("Default provider", selection: $app.providerMode) {
                    ForEach(AppModel.ProviderMode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                Text("4khdhub is the default: anime, movies and TV in up to 4K, one fast request. "
                     + "“All” aggregates every registered provider through the live feed — more sources, slower first row.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Audio") {
                Picker("Prefer", selection: $app.audioLang) {
                    Text("English (original as fallback)").tag("en")
                    Text("Original language").tag("orig")
                }
                .pickerStyle(.segmented)
                Text("English picks the English audio track when the stream has one and falls "
                     + "back to the file's original language otherwise; Original never overrides. "
                     + "Applies to playback started from then on — the waveform chip in the player "
                     + "shows the active track, click it to switch.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Open by TMDB ID") {
                HStack {
                    Picker("Type", selection: $openType) {
                        Text("Movie").tag("movie")
                        Text("Series").tag("series")
                    }
                    .frame(width: 130)
                    TextField("TMDB ID", text: $openId)
                        .frame(width: 110)
                    if openType == "series" {
                        TextField("S", text: $openSeason).frame(width: 50)
                        TextField("E", text: $openEpisode).frame(width: 50)
                    }
                    Button("Open") { openRaw() }
                        .disabled(Int(openId) == nil)
                }
                Text("For titles you already know the id of (link rot, obscure indexes).")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Playback engine") {
                HStack {
                    Image(systemName: app.mpv.isAvailable ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(app.mpv.isAvailable ? .green : .red)
                    Text(app.mpv.installHint).font(.callout)
                    Spacer()
                    Button("Re-check") { app.mpv.refreshAvailability() }
                }
                Text("The player uses embedded libmpv (linked into the app) — that is what plays MKV and 4K inline. The mpv binary above is only checked so you can see what the CLI tool is doing.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Continue Watching") {
                HStack {
                    Text(app.store.items.isEmpty
                         ? "No saved positions"
                         : "\(app.store.items.lengthWord) saved")
                    Spacer()
                    Button("Clear All", role: .destructive) { app.store.clearAll() }
                        .disabled(app.store.items.isEmpty)
                }
                Text("Positions are saved locally, every 10 seconds while playing and on stop.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("About") {
                Text("MacStream — 4khdhub-first streaming client for the local TMDB-Embed-API. "
                     + "Keyboard: Space / arrows / 1-9 / s / [ ] / m — press ? in the player for the list.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        // Grouped forms ship their own gray cards; over the true-black window we drop them so
        // Settings reads as plain text sections on black (Disney-style, no macOS translucency).
        .scrollContentBackground(.hidden)
        .background(Color.black)
        .frame(maxWidth: 620)
        .navigationTitle("Settings")
    }

    private func openRaw() {
        guard let id = Int(openId), id > 0 else { return }
        let s = Int(openSeason), e = Int(openEpisode)
        app.openById(type: openType, id: id,
                     season: openType == "series" ? s : nil,
                     episode: openType == "series" ? e : nil)
    }
}

private extension Array {
    var lengthWord: String { count == 1 ? "1 title" : "\(count) titles" }
}
