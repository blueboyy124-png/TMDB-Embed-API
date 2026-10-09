import SwiftUI

// The title screen: what it is, which season/episode, and every stream anyone has for it.
// Streams load as soon as the title opens, so Play is usually ready before you finish
// reading the overview.
struct TitleDetailView: View {
    let ref: TitleRef
    @EnvironmentObject var app: AppModel
    @State private var showDiagnostics = false

    private let episodeColumns = [GridItem(.adaptive(minimum: 250), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if ref.type == "series" { episodePicker }
                streamsSection
            }
            .padding(.bottom, 24)
        }
        .navigationTitle(app.detail?.title ?? "")
        .task(id: ref) { app.ensureLoaded(ref) }
    }

    // MARK: header

    @ViewBuilder private var header: some View {
        if let d = app.detail {
            ZStack(alignment: .bottomLeading) {
                if let b = d.backdrop {
                    PosterImage(url: b)
                        .frame(height: 220)
                        .frame(maxWidth: .infinity)
                        .clipped()
                        .overlay(LinearGradient(colors: [.clear, Color(nsColor: .windowBackgroundColor)],
                                                startPoint: .top, endPoint: .bottom))
                }
                HStack(alignment: .bottom, spacing: 16) {
                    PosterImage(url: d.poster)
                        .frame(width: 120, height: 180)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .shadow(radius: 6)
                        .padding(.leading, 20)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(d.title ?? "Untitled").font(.title2.bold())
                        HStack(spacing: 8) {
                            if let y = d.year { Text(String(y)) }
                            if let rt = d.runtime, rt > 0 { Text("\(rt / 60)h \(rt % 60)m") }
                            if let v = d.voteAverage, v > 0 {
                                Label(String(format: "%.1f", v), systemImage: "star.fill")
                                    .foregroundStyle(.orange)
                            }
                            if d.isAnime == true { Text("Anime").foregroundStyle(.purple) }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        if let genres = d.genres, !genres.isEmpty {
                            Text(genres.prefix(4).joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if let tag = d.tagline, !tag.isEmpty {
                            Text(tag).font(.caption.italic()).foregroundStyle(.secondary)
                        }
                        Button {
                            if let first = app.streams.first { app.play(first) } else { app.playSelected() }
                        } label: {
                            Label("Play", systemImage: "play.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(app.isLoadingStreams && app.streams.isEmpty)
                    }
                    .padding(.bottom, 12)
                    Spacer()
                }
            }
            if let ov = d.overview, !ov.isEmpty {
                Text(ov).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    .padding(.horizontal, 20)
            }
        } else if let e = app.streamsError, app.detailRef == ref {
            ProgressView().padding(.top, 40)
            Text(e).foregroundStyle(.orange).padding(.horizontal, 20)
        } else {
            ProgressView("Loading title…").padding(.top, 60).frame(maxWidth: .infinity)
        }
    }

    // MARK: season / episode picker

    @ViewBuilder private var episodePicker: some View {
        let seasons = app.detail?.seasons ?? []
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Episodes").font(.title3.bold())
                if app.isLoadingEpisodes { ProgressView().controlSize(.small) }
                Spacer()
                if seasons.count > 1 {
                    Picker("Season", selection: Binding(
                        get: { app.selectedSeason },
                        set: { app.selectSeason($0) }
                    )) {
                        ForEach(seasons, id: \.number) { s in
                            Text("S\(s.number) (\(s.count))").tag(s.number)
                        }
                    }
                    .pickerStyle(.menu)
                    .frame(width: 170)
                }
            }
            if app.episodes.isEmpty && !app.isLoadingEpisodes {
                Text("No episodes loaded for this season.").foregroundStyle(.secondary)
            } else {
                LazyVGrid(columns: episodeColumns, spacing: 12) {
                    ForEach(app.episodes) { e in
                        episodeCard(e)
                    }
                }
            }
        }
        .padding(.horizontal, 20)
    }

    private func episodeCard(_ e: Episode) -> some View {
        let selected = e == app.selectedEpisode
        return HStack(spacing: 8) {
            ZStack {
                PosterImage(url: e.still)
                    .frame(width: 96, height: 54)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                Button {
                    app.selectAndPlay(e)
                } label: {
                    Image(systemName: "play.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(.white)
                        .shadow(radius: 3)
                }
                .buttonStyle(.borderless)
                .help("Play \(e.label)")
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(e.label).font(.caption.bold())
                    if let abs = e.absoluteEpisode, abs != e.number {
                        Text("#\(abs)").font(.caption2).foregroundStyle(.purple)
                    }
                }
                Text(e.name ?? "Untitled").font(.caption).lineLimit(2)
                if let air = e.airDate { Text(air).font(.caption2).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
        }
        .padding(6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(selected ? Color.accentColor.opacity(0.15) : Color.primary.opacity(0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(selected ? Color.accentColor : .clear, lineWidth: 1.5)
        )
        .contentShape(Rectangle())
        .onTapGesture { app.selectEpisode(e) }
    }

    // MARK: streams

    private var streamsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Streams").font(.title3.bold())
                if app.isLoadingStreams { ProgressView().controlSize(.small) }
                Spacer()
                if let ms = app.streamsElapsed {
                    Text("\(ms) ms").font(.caption.bold()).monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }

            if let e = app.streamsError, app.streams.isEmpty {
                Text(e).foregroundStyle(.red).font(.callout).textSelection(.enabled)
            } else if app.streams.isEmpty && !app.isLoadingStreams {
                Text("No streams found for this title.").foregroundStyle(.secondary)
            }

            summary

            VStack(spacing: 2) {
                ForEach(app.streams) { s in
                    streamRow(s)
                }
            }
        }
        .padding(.horizontal, 20)
    }

    /// Speed, sources and completeness — what the old test harness answered, kept because
    /// "which source is this and is there a backup" is still the question.
    @ViewBuilder private var summary: some View {
        if !app.streams.isEmpty {
            let sources = app.sourceBreakdown
            VStack(alignment: .leading, spacing: 3) {
                Text("\(app.streams.count) stream(s) · \(sources.count) source\(sources.count == 1 ? "" : "s")")
                    .font(.callout)
                Text(sources.map { "\($0.0)×\($0.1)" }.joined(separator: ", "))
                    .font(.caption).foregroundStyle(.secondary)
                if sources.count == 1, let only = sources.first {
                    Text("⚠ single source (\(only.0)) — no redundancy if it goes down")
                        .font(.caption).foregroundStyle(.orange)
                }
                if let resp = app.streamResponse, let pending = resp.pending, !pending.isEmpty {
                    Text("still working: \(pending.joined(separator: ", "))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                DisclosureGroup("Data diagnostics", isExpanded: $showDiagnostics) {
                    HStack(spacing: 4) {
                        ForEach(app.checks) { c in
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
                    .padding(.top, 4)
                }
                .font(.caption)
            }
        }
    }

    private func streamRow(_ s: Stream) -> some View {
        HStack(spacing: 8) {
            Button("Play") { app.play(s) }
                .controlSize(.small)
            VStack(alignment: .leading, spacing: 1) {
                Text(s.displayTitle).font(.caption).lineLimit(1)
                // The provider's own title, verbatim (size, codec, group tag) when present.
                if let src = s.sourceTitle, !src.isEmpty {
                    Text(src).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            if let tag = s.tag {
                Text(tag).font(.caption2)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(tag == "anime" ? Color.purple.opacity(0.2) : Color.secondary.opacity(0.15)))
            }
            Text(s.languageLabel ?? "—")
                .font(.caption2).foregroundStyle(.secondary).frame(width: 64, alignment: .leading)
            Text(s.quality ?? "?").font(.caption2).monospacedDigit().frame(width: 52, alignment: .leading)
            Text(s.container ?? "?").font(.caption2)
                .foregroundStyle(s.container == "mkv" ? Color.orange : Color.secondary)
                .frame(width: 42, alignment: .leading)
            Text("+\(String(format: "%.1f", Double(s.arrivalMs) / 1000))s")
                .font(.caption2).foregroundStyle(.secondary).frame(width: 48, alignment: .trailing)
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 6)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.04)))
    }
}
