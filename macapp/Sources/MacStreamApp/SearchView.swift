import SwiftUI

// Search: one field, a poster grid, and honest empty/error states (a TMDB rate limit is not
// "no results" — the API already separates them and the message is passed through).
struct SearchView: View {
    @EnvironmentObject var app: AppModel
    @FocusState private var focused: Bool

    private let columns = [GridItem(.adaptive(minimum: 138), spacing: 16)]

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search titles…", text: $app.searchQuery)
                    .textFieldStyle(.plain)
                    .focused($focused)
                    .onSubmit { app.doSearch() }
                if !app.searchQuery.isEmpty {
                    Button {
                        app.searchQuery = ""
                        app.searchResults = []
                        app.searchError = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                }
                Button("Search") { app.doSearch() }
                    .disabled(app.isSearching)
            }
            .padding(10)
            .background(Rectangle().fill(Color.primary.opacity(0.05)))
            .padding(.horizontal, 16)
            .padding(.top, 12)

            content
        }
        .background(Color.black)
        .onAppear { focused = true }
    }

    @ViewBuilder private var content: some View {
        if app.isSearching {
            ProgressView("Searching…").padding(.top, 60).frame(maxWidth: .infinity)
        } else if let e = app.searchError, app.searchResults.isEmpty {
            VStack(spacing: 8) {
                Text(e).foregroundStyle(.red).textSelection(.enabled)
                Button("Retry") { app.doSearch() }
            }
            .padding(.top, 60).frame(maxWidth: .infinity)
        } else if app.searchResults.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "film.stack").font(.system(size: 34)).foregroundStyle(.secondary)
                Text(app.searchQuery.isEmpty ? "Search for a movie or series" : "No results")
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 60).frame(maxWidth: .infinity)
        } else {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(app.searchResults) { r in
                        Button { app.open(r.ref) } label: {
                            PosterCard(title: r.title, year: r.year, rating: r.rating, poster: r.poster)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
        }
    }
}
