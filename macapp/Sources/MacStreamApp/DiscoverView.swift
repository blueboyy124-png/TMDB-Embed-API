import SwiftUI

// Shared poster tile for the discover/search grids.
struct PosterCard: View {
    let title: String
    let year: String?
    let rating: Double?
    let poster: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            PosterImage(url: poster)
                .frame(width: 138, height: 207)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.primary.opacity(0.08), lineWidth: 1)
                )
            Text(title)
                .font(.caption)
                .lineLimit(1)
            HStack(spacing: 6) {
                if let y = year { Text(y).font(.caption2).foregroundStyle(.secondary) }
                if let r = rating {
                    Label(String(format: "%.1f", r), systemImage: "star.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
        }
        .frame(width: 138)
        .contentShape(Rectangle())
    }
}

/// Cached TMDB image with a quiet placeholder (never a spinner: a poster grid flashing
/// spinners makes the app feel broken while it is working fine).
struct PosterImage: View {
    let url: String?
    @State private var image: NSImage?

    var body: some View {
        ZStack {
            Rectangle().fill(Color.primary.opacity(0.07))
            if let image {
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
            } else if url != nil {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: "photo").foregroundStyle(.secondary)
            }
        }
        .task(id: url) {
            image = await ImageStore.shared.image(for: url)
        }
    }
}

// MARK: - Discover

struct DiscoverView: View {
    @EnvironmentObject var app: AppModel

    private let columns = [GridItem(.adaptive(minimum: 138), spacing: 16)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if !app.store.items.isEmpty { continueRow }
                trendingSection
            }
            .padding(16)
        }
        .onAppear { app.loadTrendingIfNeeded() }
    }

    // MARK: continue watching

    private var continueRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Continue Watching").font(.title3.bold())
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(app.store.items) { item in
                        ContinueCard(item: item)
                    }
                }
            }
        }
    }
}

private struct ContinueCard: View {
    @EnvironmentObject var app: AppModel
    let item: ContinueItem

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ZStack(alignment: .bottomLeading) {
                PosterImage(url: item.poster)
                    .frame(width: 240, height: 135)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                // Progress bar: where you stopped, not decoration.
                GeometryReader { geo in
                    Rectangle()
                        .fill(Color.accentColor)
                        .frame(width: geo.size.width * item.progress)
                        .frame(maxHeight: .infinity, alignment: .bottom)
                }
                .frame(height: 4)
                .padding(6)
            }
            .overlay(alignment: .center) {
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(.white.opacity(0.9))
                    .shadow(radius: 4)
            }
            Text(item.title).font(.caption.weight(.semibold)).lineLimit(1)
            HStack(spacing: 6) {
                if let sub = item.subtitle { Text(sub).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                Spacer()
                Text(timeLeft).font(.caption2).foregroundStyle(.secondary)
            }
            HStack {
                Button("Resume") { app.resume(item) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                Button("Details") { app.open(TitleRef(id: item.tmdbId, type: item.type)) }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
            }
        }
        .frame(width: 240)
        .contextMenu {
            Button("Remove from Continue Watching") { app.store.remove(item.key) }
        }
    }

    private var timeLeft: String {
        let left = max(0, item.duration - item.position)
        let m = Int(left) / 60
        return m >= 60 ? "\(m / 60)h \(m % 60)m left" : "\(m)m left"
    }
}

// MARK: - trending

private extension DiscoverView {
    var trendingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Trending This Week").font(.title3.bold())
                Spacer()
                Button {
                    app.trending = []
                    app.loadTrendingIfNeeded()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh")
            }

            if app.isLoadingTrending && app.trending.isEmpty {
                ProgressView("Loading trending…").padding(.top, 30)
                    .frame(maxWidth: .infinity)
            } else if let e = app.trendingError, app.trending.isEmpty {
                VStack(spacing: 6) {
                    Text(e).foregroundStyle(.red).font(.callout)
                    Button("Retry") {
                        app.trending = []
                        app.loadTrendingIfNeeded()
                    }
                }
                .frame(maxWidth: .infinity).padding(.top, 30)
            } else {
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(app.trending) { r in
                        Button {
                            app.open(r.ref)
                        } label: {
                            PosterCard(title: r.title, year: r.year, rating: r.rating, poster: r.poster)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}
