import SwiftUI

// The title page: full-bleed hero art fading into black, the essentials, and one Play button —
// the Netflix detail flow. Streams are gathered quietly in the background; pressing Play enters
// the player screen immediately (spinner until the first row is ready), and manual stream
// picking lives in the player's Streams drawer, not here.
struct TitleDetailView: View {
    let ref: TitleRef
    @EnvironmentObject var app: AppModel

    private let episodeColumns = [GridItem(.adaptive(minimum: 260), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                hero
                info
            }
        }
        .background(Color.black)
        .task(id: ref) { app.ensureLoaded(ref) }
    }

    // MARK: hero

    @ViewBuilder private var hero: some View {
        if let d = app.detail {
            ZStack(alignment: .bottomLeading) {
                if let b = d.backdrop {
                    PosterImage(url: b)
                        .frame(height: 400)
                        .frame(maxWidth: .infinity)
                        .clipped()
                        .overlay(
                            LinearGradient(colors: [.clear, .black.opacity(0.55), .black],
                                           startPoint: .top, endPoint: .bottom)
                        )
                        .overlay(
                            LinearGradient(colors: [.black.opacity(0.6), .clear],
                                           startPoint: .leading, endPoint: .trailing)
                        )
                } else {
                    Rectangle().fill(Color.black).frame(height: 240)
                }

                VStack(alignment: .leading, spacing: 12) {
                    if let logo = d.logo, !logo.isEmpty {
                        PosterImage(url: logo)
                            .frame(height: 70)
                            .frame(maxWidth: 260, alignment: .leading)
                            .clipped()
                    } else {
                        Text(d.title ?? "Untitled")
                            .font(.system(size: 36, weight: .bold))
                            .lineLimit(2)
                    }

                    HStack(spacing: 10) {
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

                    playRow

                    if let tag = d.tagline, !tag.isEmpty {
                        Text(tag).font(.callout.italic()).foregroundStyle(.secondary)
                    }
                }
                .padding(.leading, 28)
                .padding(.bottom, 22)
                .padding(.trailing, 28)
            }
        } else if app.detailRef == ref, app.detail == nil, app.isLoadingStreams {
            ProgressView("Loading title…")
                .padding(.top, 80).frame(maxWidth: .infinity)
                .foregroundStyle(.white)
        } else {
            ProgressView("Loading title…")
                .padding(.top, 80).frame(maxWidth: .infinity)
                .foregroundStyle(.white)
        }
    }

    /// Play, or Resume when this title (or this episode) has a saved position. Pressing it
    /// switches the window into the player right away — the spinner covers the stream fetch.
    private var playRow: some View {
        let item = app.continueItemForCurrentSelection()
        let resumeAt = (item?.position ?? 0) >= 15 ? (item?.position ?? 0) : 0
        return HStack(spacing: 12) {
            Button {
                app.playFromDetail(resume: resumeAt)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "play.fill")
                    Text(resumeAt > 0 ? "Resume" : "Play")
                        .font(.headline)
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 11)
                .background(Color.white)
                .foregroundStyle(Color.black)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            .buttonStyle(.plain)
            .disabled(app.isLoadingStreams && app.streams.isEmpty && app.streamsError == nil)

            if resumeAt > 0, let fmt = optionalFormat(resumeAt) {
                Text("at \(fmt)").font(.caption).foregroundStyle(.secondary)
            }

            // Quiet progress: streams are being gathered in the background.
            if app.isLoadingStreams && app.streams.isEmpty {
                ProgressView().controlSize(.small)
                Text("Gathering streams…").font(.caption).foregroundStyle(.secondary)
            } else if !app.streams.isEmpty {
                Text("\(app.streams.count) stream\(app.streams.count == 1 ? "" : "s") ready")
                    .font(.caption).foregroundStyle(.secondary)
            } else if let e = app.streamsError, app.streams.isEmpty {
                Text(e).font(.caption).foregroundStyle(.orange).lineLimit(1)
            }
            Spacer()
        }
    }

    private func optionalFormat(_ t: Double) -> String? {
        guard t.isFinite, t >= 0 else { return nil }
        let i = Int(t)
        return "\(i / 60):\(String(format: "%02d", i % 60))"
    }

    // MARK: body content

    @ViewBuilder private var info: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let ov = app.detail?.overview, !ov.isEmpty {
                Text(ov).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if ref.type == "series" { episodePicker }
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 28)
        .padding(.top, 14)
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
    }

    private func episodeCard(_ e: Episode) -> some View {
        let selected = e == app.selectedEpisode
        return HStack(spacing: 10) {
            ZStack {
                PosterImage(url: e.still)
                    .frame(width: 104, height: 59)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                Button {
                    app.selectAndPlay(e)
                } label: {
                    Image(systemName: "play.circle.fill")
                        .font(.system(size: 24))
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
                .fill(selected ? Color.white.opacity(0.12) : Color.white.opacity(0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(selected ? Color.white.opacity(0.6) : .clear, lineWidth: 1.5)
        )
        .contentShape(Rectangle())
        .onTapGesture { app.selectEpisode(e) }
    }
}
