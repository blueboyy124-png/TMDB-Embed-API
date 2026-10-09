import Foundation

// Hands a stream to mpv when AVPlayer cannot handle it.
//
// Why this exists: macOS AVPlayer does not decode Matroska. Every 4K stream this API returns is an MKV, so
// a pure-AVPlayer app plays the 1080p versions and shows a black screen for the good ones. mpv decodes
// MKV, HEVC and everything else, and is a single `brew install mpv` away.
//
// mpv is OPTIONAL. Without it the app still plays everything AVPlayer can, and says plainly which
// streams it skipped and why, rather than offering a button that fails.
//
// It runs as a subprocess rather than being linked as libmpv because that keeps this a single Swift
// package with no C interop, no header search paths, and no Homebrew linkage to go wrong when the
// machine updates. The cost is a separate player window instead of inline playback -- acceptable,
// because this is only used for the formats native playback cannot do anyway.

@MainActor
final class MPVRunner: ObservableObject {
    @Published var isAvailable: Bool = false
    @Published var mpvPath: String = ""
    @Published var lastError: String = ""

    private var process: Process?

    init() { refreshAvailability() }

    /// Looks for mpv in the places Homebrew puts it. Checked every refresh rather than cached at
    /// launch so installing mpv while the app is open is picked up without a restart.
    func refreshAvailability() {
        var found: String?
        let candidates = [
            "/opt/homebrew/bin/mpv",   // Apple silicon
            "/usr/local/bin/mpv",      // Intel
            "/opt/local/bin/mpv"       // MacPorts
        ]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) { found = c; break }

        if found == nil {
            // Fall back to PATH, so a non-standard install still works.
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = ["which", "mpv"]
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = Pipe()
            if (try? p.run()) != nil {
                p.waitUntilExit()
                let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if p.terminationStatus == 0, !out.isEmpty, FileManager.default.isExecutableFile(atPath: out) {
                    found = out
                }
            }
        }
        mpvPath = found ?? ""
        isAvailable = found != nil
    }

    var installHint: String {
        isAvailable ? "mpv: \(mpvPath)" : "mpv not found — install with: brew install mpv"
    }

    /// Plays `url` in an mpv window. The URL is the API's own proxied URL, which matters: mpv is given a
    /// plain http(s) URL with no Referer requirement, and the proxy has already resolved redirects.
    func play(url: String, title: String) {
        stop()
        guard isAvailable, !mpvPath.isEmpty else {
            lastError = "mpv is not installed. MKV (and so 4K) needs it: brew install mpv"
            return
        }
        lastError = ""

        let p = Process()
        p.executableURL = URL(fileURLWithPath: mpvPath)
        // --force-window so it opens a window rather than trying to attach to a TTY; --ytdl and
        // --no-terminal stop it printing to stdout, which would otherwise interleave with ours.
        p.arguments = [
            url,
            "--force-window=yes",
            // Boolean flags take NO `=value`. "--no-terminal=yes" made mpv print
            // "Error parsing option terminal (option doesn't take a parameter)" and exit immediately, so every
            // MKV/4K stream failed to launch with an error the app never saw.
            "--no-terminal",
            "--ytdl=yes",
            "--title=\(title)"
        ]
        do {
            try p.run()
            process = p
        } catch {
            lastError = "Could not start mpv: \(error.localizedDescription)"
        }
    }

    func stop() {
        if let p = process, p.isRunning { p.terminate() }
        process = nil
    }

    deinit { if let p = process, p.isRunning { p.terminate() } }
}