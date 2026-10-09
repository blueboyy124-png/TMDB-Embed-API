# MacStream — native macOS client

A SwiftUI macOS app that browses and plays from the TMDB-Embed-API server
(`http://localhost:8787`). Videos render **inside the app window** through
libmpv's render API — no external player, no second window.

## Build & run

```sh
cd macapp
swift build
.build/debug/MacStreamApp          # server must be running on :8787
```

Requires `libmpv` (Homebrew `mpv`) — the package links `-L/opt/homebrew/lib -lmpv`.
The server URL, provider mode (4khdhub / anime / All) and open-by-id live in
Settings; everything else needs no configuration.

## Layout

- **Sidebar** (Discover / Search / Settings) in a `NavigationSplitView`.
- **Detail** — backdrop, poster, metadata, genre chips, Play, season/episode
  picker for series, and the aggregated stream rows (quality · provider ·
  language) for manual selection.
- **Player pane** — pinned at the window root, *above* the split view. This is
  load-bearing: an `NSViewRepresentable` inside the split view's detail column
  never receives a window (SwiftUI never commits the host to the tree), so the
  video view only renders when it is a root-level overlay.

## Playback architecture

- `MPVView` drives libmpv with `vo=libmpv` + `mpv_render_context`, drawing into
  a `CAOpenGLLayer` (3.2 core). The render context is created **before**
  `mpv_initialize`; GL symbols resolve via `dlsym(RTLD_DEFAULT)`.
- All mpv control calls run asynchronously on the controller's serial queue —
  blocking main on mpv's internal lock is how the app used to beachball.
- Teardown (`shutdown`) frees the render context first (GL context current),
  then the core, off-main. `stop()` clears UI state only once the mpv handle is
  truly gone, which also keeps the last frame visible during teardown.
- Resume and row switches use mpv's per-file `start=` option
  (`loadfile <url> replace start=<sec>`), so the first frame lands at the saved
  position instead of flashing 0:00 and jumping.
- Continue Watching is flushed every 10s while playing and on stop, dropped at
  ≥95% or <15s.

## Keyboard

Space play/pause · ←/→ −10s/+10s (Shift: 60s) · ↑/↓ previous/next stream row ·
1–9 direct row · `[`/`]` previous/next episode (crosses season boundaries) ·
`f` fullscreen · `m` mute · `?` key help · `Esc` dismiss stall offer → exit
fullscreen → stop. Shortcuts pass through when ⌘ is held or a text field,
slider, table or button has focus.

Stalls **offer, don't auto-switch**: if the picture freezes for 15s mid-play
(not at end of file, not while paused), a banner asks “Switch to next row (⏎) /
Dismiss (⎋)”.

## Verification hooks

Environment variables for headless test runs (ignored in normal use):

| Variable | Effect |
| --- | --- |
| `AUTOPLAY=1` | Open the test title and play the first row with no clicks |
| `AUTOPLAY_TYPE` / `AUTOPLAY_ID` | Title to open (default `movie` / `1083381` Backrooms) |
| `AUTOPLAY_SEASON` / `AUTOPLAY_EPISODE` | Episode to preselect for a series |
| `STOP_AFTER=<sec>` | Press Stop that many seconds after playback starts |
| `RELOAD_AFTER=<sec>` | Stop + full rebuild (fresh controller, fresh attach) at the deadline |
| `SWITCH_AFTER=<sec>` | Mid-playback row switch on the running player at the deadline |
| `EPISODE_NEXT_AFTER=<sec>` | Press ] (next episode / season boundary) that many seconds in |

Playback state is logged with an `[mpv]` prefix (attach chain, first frame,
loadfile, stall offers, teardown). `/tmp/mpvsock` is an mpv IPC socket while a
player is live (`echo '{"command":["get_property","pause"]}' | socat - /tmp/mpvsock`).
