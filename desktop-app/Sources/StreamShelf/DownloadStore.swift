import Foundation

struct DesktopDownloadRequest {
    let title: String
    let detail: String
    let url: URL
    let quality: String
    let headers: [String: String]

    init?(dictionary: [String: Any]) {
        guard let rawURL = dictionary["url"] as? String, let url = URL(string: rawURL),
              ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        title = (dictionary["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).prefix(180).description ?? "Untitled download"
        detail = (dictionary["detail"] as? String)?.prefix(180).description ?? ""
        quality = (dictionary["quality"] as? String)?.prefix(40).description ?? "Auto"
        self.url = url
        let rawHeaders = dictionary["headers"] as? [String: Any] ?? [:]
        headers = rawHeaders.reduce(into: [:]) { result, pair in
            guard pair.key.range(of: "^[A-Za-z0-9-]{1,80}$", options: .regularExpression) != nil,
                  let value = pair.value as? String, value.count <= 4096 else { return }
            result[pair.key] = value
        }
    }
}

enum DownloadState: String, Codable { case queued, downloading, paused, completed, failed }

struct DownloadItem: Codable, Identifiable {
    var id: UUID
    var title: String
    var detail: String
    var quality: String
    var sourceURL: URL
    var state: DownloadState
    var progress: Double
    var localPath: String?
    var error: String?
    var createdAt: Date
    var localURL: URL? { localPath.map(URL.init(fileURLWithPath:)) }
}

final class DownloadStore: NSObject, ObservableObject, URLSessionDownloadDelegate {
    @Published private(set) var items: [DownloadItem] = []
    var onChange: (() -> Void)?
    private let fm = FileManager.default
    private let root: URL
    private let indexURL: URL
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: "local.streamshelf.downloads")
        config.sessionSendsLaunchEvents = true
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }()
    private var taskToItem: [Int: UUID] = [:]

    override init() {
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!.appendingPathComponent("StreamShelf", isDirectory: true)
        root = support.appendingPathComponent("Downloads", isDirectory: true)
        indexURL = support.appendingPathComponent("downloads.json")
        super.init()
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: indexURL), let saved = try? JSONDecoder().decode([DownloadItem].self, from: data) { items = saved }
    }

    func enqueue(_ request: DesktopDownloadRequest) {
        // A selected quality identifies the one local version allowed for this title/episode.
        guard !items.contains(where: { $0.sourceURL == request.url && $0.state != .failed }) else { return }
        var item = DownloadItem(id: UUID(), title: request.title, detail: request.detail, quality: request.quality, sourceURL: request.url, state: .queued, progress: 0, localPath: nil, error: nil, createdAt: Date())
        if request.url.path.lowercased().contains(".m3u8") {
            item.state = .failed
            item.error = "This HLS source cannot be saved as a standalone file. Choose a direct, non-DRM source."
            items.insert(item, at: 0); persist(); changed(); return
        }
        var urlRequest = URLRequest(url: request.url)
        request.headers.forEach { urlRequest.setValue($0.value, forHTTPHeaderField: $0.key) }
        let task = session.downloadTask(with: urlRequest)
        task.taskDescription = item.id.uuidString
        taskToItem[task.taskIdentifier] = item.id
        item.state = .downloading
        items.insert(item, at: 0)
        persist(); changed(); task.resume()
    }

    func delete(_ item: DownloadItem) {
        if let task = taskToItem.first(where: { $0.value == item.id })?.key { session.getAllTasks { $0.first(where: { $0.taskIdentifier == task })?.cancel() } }
        if let local = item.localURL { try? fm.removeItem(at: local) }
        items.removeAll { $0.id == item.id }; persist(); changed()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let id = itemID(for: downloadTask), let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].progress = totalBytesExpectedToWrite > 0 ? Double(totalBytesWritten) / Double(totalBytesExpectedToWrite) : 0
        changed()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = itemID(for: downloadTask), let i = items.firstIndex(where: { $0.id == id }) else { return }
        let ext = downloadTask.response?.suggestedFilename.flatMap { URL(fileURLWithPath: $0).pathExtension } ?? items[i].sourceURL.pathExtension
        let destination = root.appendingPathComponent("\(id.uuidString).\(ext.isEmpty ? "video" : ext)")
        do {
            try? fm.removeItem(at: destination)
            try fm.moveItem(at: location, to: destination)
            items[i].localPath = destination.path; items[i].progress = 1; items[i].state = .completed; items[i].error = nil
        } catch { items[i].state = .failed; items[i].error = error.localizedDescription }
        persist(); changed()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, let id = itemID(for: task), let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].state = .failed; items[i].error = error.localizedDescription; persist(); changed()
    }

    private func itemID(for task: URLSessionTask) -> UUID? {
        taskToItem[task.taskIdentifier] ?? task.taskDescription.flatMap(UUID.init(uuidString:))
    }
    private func persist() { if let data = try? JSONEncoder().encode(items) { try? data.write(to: indexURL, options: .atomic) } }
    private func changed() { onChange?(); objectWillChange.send() }
}
