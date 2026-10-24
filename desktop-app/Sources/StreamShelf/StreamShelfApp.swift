import SwiftUI
import WebKit
import AVFoundation

@main
struct StreamShelfApp: App {
    @StateObject private var model = DesktopModel()

    var body: some Scene {
        WindowGroup("StreamShelf") {
            WebContainer(model: model)
                .frame(minWidth: 980, minHeight: 680)
                .toolbar {
                    ToolbarItemGroup(placement: .automatic) {
                        Text(model.apiOnline ? "API connected" : "API unavailable")
                            .foregroundStyle(model.apiOnline ? .green : .orange)
                        Button("Downloads") { model.showDownloads = true }
                    }
                }
                .sheet(isPresented: $model.showDownloads) {
                    DownloadLibrary(model: model)
                }
        }
        .windowResizability(.contentMinSize)
    }
}

@MainActor
final class DesktopModel: ObservableObject {
    @Published var apiOnline = false
    @Published var showDownloads = false
    let uiStore = StreamerUIStore()
    let downloads = DownloadStore()
    weak var webView: WKWebView?

    init() {
        downloads.onChange = { [weak self] in self?.publishDownloads() }
    }

    func refreshUI() {
        Task {
            let updated = await uiStore.syncFromAPI()
            apiOnline = updated.reachable
            if updated.didUpdate { loadWebUI() }
            publishDownloads()
        }
    }

    func loadWebUI() {
        guard let webView else { return }
        var components = URLComponents()
        components.scheme = "streamer"
        components.host = "app"
        components.path = "/index.html"
        // The normal web app already supports ?api=. It remains completely unaware that a
        // desktop wrapper supplied it.
        components.queryItems = [URLQueryItem(name: "api", value: uiStore.server)]
        webView.load(URLRequest(url: components.url!))
    }

    func enqueue(_ request: DesktopDownloadRequest) {
        downloads.enqueue(request)
        publishDownloads()
    }

    func publishDownloads() {
        guard let webView else { return }
        let data = (try? JSONEncoder().encode(downloads.items)) ?? Data("[]".utf8)
        let json = String(data: data, encoding: .utf8) ?? "[]"
        webView.evaluateJavaScript("window.StreamShelfDesktop && window.StreamShelfDesktop.setDownloads(\(json));")
    }
}

struct WebContainer: NSViewRepresentable {
    @ObservedObject var model: DesktopModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let controller = config.userContentController
        controller.addUserScript(WKUserScript(source: DesktopBridge.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(context.coordinator, name: "streamShelf")
        config.setURLSchemeHandler(context.coordinator.schemeHandler, forURLScheme: "streamer")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        model.webView = view
        model.refreshUI()
        model.loadWebUI()
        return view
    }

    func updateNSView(_ nsView: WKWebView, context: Context) { }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let model: DesktopModel
        let schemeHandler: StreamerSchemeHandler

        init(model: DesktopModel) {
            self.model = model
            self.schemeHandler = StreamerSchemeHandler(store: model.uiStore)
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "streamShelf",
                  let object = message.body as? [String: Any],
                  let kind = object["kind"] as? String else { return }
            switch kind {
            case "download":
                guard let payload = object["payload"] as? [String: Any],
                      let request = DesktopDownloadRequest(dictionary: payload) else { return }
                model.enqueue(request)
            case "library":
                model.showDownloads = true
            case "apiStatus":
                model.apiOnline = object["online"] as? Bool ?? false
            default:
                break
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            model.publishDownloads()
        }
    }
}

final class StreamerSchemeHandler: NSObject, WKURLSchemeHandler {
    let store: StreamerUIStore
    init(store: StreamerUIStore) { self.store = store }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return urlSchemeTask.didFailWithError(URLError(.badURL)) }
        let requested = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let relative = requested.isEmpty ? "index.html" : requested
        guard !relative.contains(".."), let file = store.fileURL(relative) else {
            return urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
        }
        do {
            let data = try Data(contentsOf: file)
            let response = URLResponse(url: url, mimeType: mimeType(for: file.pathExtension), expectedContentLength: data.count, textEncodingName: nil)
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch { urlSchemeTask.didFailWithError(error) }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { }

    private func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html"
        case "js": return "application/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        default: return "application/octet-stream"
        }
    }
}

struct DownloadLibrary: View {
    @ObservedObject var model: DesktopModel
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Downloads").font(.title2.bold())
                Spacer()
                Button("Done") { model.showDownloads = false }
            }
            if model.downloads.items.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "arrow.down.circle").font(.system(size: 34))
                    Text("No downloads").font(.headline)
                    Text("Choose Download in the app while the API is available.").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(model.downloads.items) { item in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(item.title).lineLimit(1)
                            Text(item.detail).font(.caption).foregroundStyle(.secondary)
                            if item.state == .downloading { ProgressView(value: item.progress) }
                            if let error = item.error { Text(error).font(.caption).foregroundStyle(.red) }
                        }
                        Spacer()
                        Text(item.state.rawValue.capitalized).font(.caption)
                        if item.state == .completed, let url = item.localURL {
                            Button("Play") { NSWorkspace.shared.open(url) }
                        }
                        Button(role: .destructive) { model.downloads.delete(item) } label: { Image(systemName: "trash") }
                    }
                }
            }
        }
        .padding()
        .frame(minWidth: 620, minHeight: 400)
    }
}
