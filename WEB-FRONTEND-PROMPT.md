# Handoff Prompt — Build the MacStream Web Frontend

> Paste everything below into the other AI's chat. It is self-contained: it describes the
> existing backend, the exact API contracts, the browser limitations, and the behavior the
> frontend must replicate. Do not change the backend; build the website only.

---

## 1. Your mission

Build a **web frontend (plain HTML + CSS + JavaScript, no build step required)** that talks to an
**already-running local Node.js API** and plays video in a browser. It is a "quick" version of an
existing native macOS app ("MacStream"). Reuse the API as-is — **do not rewrite or modify the
server**. Deliver a real website the user can open in a browser and use to browse, search, and
watch.

- Deliverable: static files (`index.html`, `app.js`, `styles.css`, plus a small `player.js`) that
  can be served over `http://localhost` and call the API at `http://localhost:8787`.
- Stack: vanilla JS. Use **hls.js** (CDN is fine) for HLS playback. No framework required.
- Look: **true-black theme** (`#000` background) with a **neutral-white** accent. Minimal,
  cinematic, no chrome clutter.

---

## 2. Existing system you are building on

- A **Node.js REST API + media proxy** runs at **`http://localhost:8787`** (bound to localhost).
  It aggregates stream links from ~10 providers, link-checks them, and rewrites video URLs through
  its own proxy routes so the browser can fetch them without CORS/referer problems.
- It is started by the owner with `npm start` inside the `TMDB-Embed-API` directory. You do **not**
  need to start it, but your docs should say: the API must be running on `:8787` first.
- There is an **existing diagnostic web player** at `public/player.html` (served by the API at
  `http://localhost:8787/player.html`) that already demonstrates the hls.js + `/m3u8-proxy`
  pipeline. Read it as a working reference for the playback plumbing. It is a diagnostics tool,
  not the UI you are building.
- There is a `.verify/` folder with shell test scripts and `curl` recipes if you want examples.

### How to serve your frontend

Because the API emits a global CORS header (`Access-Control-Allow-Origin: *`), you can serve the
frontend from **any** local static server, e.g.:

```
cd <your-web-folder>
python3 -m http.server 5500
# open http://localhost:5500
```

You can also drop the files into the API's `public/` folder and serve them from
`http://localhost:8787/` directly. Either is fine. **Do not** open the HTML via `file://` —
`fetch`/XHR to the API and media playback both require an `http(s)` origin.

---

## 3. HARD CONSTRAINTS (read before coding)

These are the things that will silently break the site if ignored.

1. **Codec support is limited by the browser.** The API labels every stream with a `container`
   field and a `playableInBrowser` boolean.
   - `container: "m3u8"` → HLS. Play with **hls.js** (`playableInBrowser: true`).
   - `container: "mp4"` → play with a native `<video src>` (`playableInBrowser: true`).
   - `container: "mkv"` → **`playableInBrowser: false`**. These are typically 4K HEVC/H.265 in an
     MKV container and **will not play in Chrome/Safari/Firefox**. Filter them out of the default
     list, or show them disabled with a "not supported in browser" badge. Never auto-select one.
   - You may still expose MKV rows for power users with a clear warning, but the default
     auto-selected stream must be `playableInBrowser !== false`.
2. **Always play through the proxied URL**, never the raw provider URL. If a returned stream URL
   starts with `http://localhost:8787/`, use it verbatim. The API is the thing that makes
   cross-origin provider links work.
3. **Call the API on the exact same host the browser used.** The API builds proxy URLs from the
   request's `Host` header. If the page is on `localhost`, call `http://localhost:8787`; if on
   `127.0.0.1`, call `http://127.0.0.1:8787`. Mixing them is a common cause of dead streams.
4. **HLS `.m3u8` URLs must NOT be given directly to `<video src>`** except on Safari (which has
   native HLS). Use hls.js for Chrome/Firefox/Edge. Feature-detect: use native HLS if
   `video.canPlayType('application/vnd.apple.mpegurl')` is truthy, else hls.js.
5. **Audio-track selection is automatic in the browser.** The native app has explicit English-first
   audio logic, but a browser `<video>` element picks a default audio track itself and exposes
   alternatives only via `video.audioTracks` (limited support) — HLS.js exposes
   `hls.audioTracks` / `hls.currentLevel`. Do a best-effort English-preferred selection when
   multiple audio tracks are exposed, and otherwise accept the browser default. Do not claim exact
   parity here.
6. **Quality switching:** use hls.js's built-in level list for adaptive quality if the source is a
   master playlist; there is no external "quality switch" API. The "Streams" list (different
   provider/quality rows) is the real manual override.

---

## 4. API reference (all read endpoints are public — no auth needed)

Base URL: `http://localhost:8787`. All responses are JSON unless noted. `type` is `"movie"` or
`"series"`.

### 4.1 Health (use for a "server offline" banner)

```
GET /api/health
→ { "ok": true, "service": "tmdb-embed-api", "time": "...", "proxy": { "enabled": true, "mounted": true }, ... }
```

### 4.2 Browse — trending

```
GET /api/trending
→ { "success": true, "window": "...", "results": [ { "id":123542, "type":"series",
     "title":"LINK CLICK", "overview":"...", "poster":"https://image.tmdb.org/t/p/w342/....jpg",
     "year":"2021", "rating":8.2 }, ... ] }   // ~20 items
```

### 4.3 Search

```
GET /api/search?q=<query>
→ { "success":true, "query":"...", "page":1, "totalResults":N,
    "results":[ { "id":969681, "type":"movie", "title":"...", "overview":"...",
                  "poster":"https://image.tmdb.org/t/p/w342/....jpg", "year":"2026", "rating":8.4 }, ... ] }
```

`results[]` items share the same shape as trending items: `{ id, type, title, overview, poster, year, rating }`.

### 4.4 Title metadata (detail page)

```
GET /api/metadata/:type/:tmdbId
→ { "success":true, "tmdbId":"969681", "type":"movie",
    "title":"...", "originalTitle":"...", "alternativeTitles":[],
    "overview":"...", "tagline":"...", "status":"Released",
    "genres":["Science Fiction","Action"], "poster":"https://image.tmdb.org/t/p/w342/....jpg",
    "backdrop":"https://image.tmdb.org/t/p/w1280/....jpg", "logo":"...",
    "releaseDate":"2026-...", "year":"2026", "runtime":..., "voteAverage":8.4,
    "seasonCount":..., "episodeCounts":{...}, "isAnime": false,
    "externalIds":{...}, "anilist":..., "episode":null }
```

Use `poster`/`backdrop` for imagery, `overview`/`tagline`/`genres`/`year`/`voteAverage` for the
detail layout. `runtime` is minutes. For series, `seasonCount` and `episodeCounts` drive the season
picker.

### 4.5 Episodes (series only)

```
GET /api/metadata/series/:tmdbId/episodes?season=1
→ { "success":true, "tmdbId":"1399", "season":1, "seasonName":"Season 1",
    "totalEpisodes":10, "count":10,
    "episodes":[ { "season":1, "episode":1, "absoluteEpisode":1, "seasonRelativeEpisode":1,
                   "name":"Winter Is Coming", "overview":"...", "airDate":"2011-04-17",
                   "runtime":62, "rating":8.168,
                   "still":"https://image.tmdb.org/t/p/w300/....jpg" }, ... ] }
```

### 4.6 Streams — the core endpoint (aggregate across providers)

```
GET /api/streams/:type/:tmdbId
Optional query:
  ?season=<n>&episode=<n>   for series
  ?deadline=<ms>            how long to wait before returning (default built in ~a few seconds)
  ?perStreamMeta=1          include repeated per-episode fields on every row (verbose)
→ {
    "success": true,
    "tmdbId": "969681",
    "imdbId": "tt22084616",
    "count": 45,
    "providerTimings": { "vaplayer":1896, "vidlink":2139, ... },
    "providerStatus": { "vaplayer":"ok", "dahmermovies":"empty", "4khdhub":"pending", ... },
    "partial": true,
    "stopReason": "enough",
    "bestQuality": { "value":2160, "label":"2160p", "provider":"Febbox FID" },
    "linkCheck": { "checked":45, "dead":0, ... },
    "pending": [ ... ],
    "timings": { ... },
    "episode": { ... } | null,      // present when perStreamMeta is off
    "streams": [ <Stream>, ... ]
  }
```

`providerStatus` values: `"ok" | "empty" | "timeout" | "error" | "disabled" | "pending"`.
`"empty"` = the provider has nothing; `"pending"` = it hadn't answered before the deadline
(re-request with a larger `?deadline=` to collect it).

**Stream object** (fields you will actually use):

```jsonc
{
  "name": "Spider-Man: Brand New Day (2026) - AUTO",   // display label (episode name when known)
  "title": "…",                                        // same as name for display
  "url": "http://localhost:8787/m3u8-proxy?url=…",     // PLAY THIS (already proxied)
  "quality": "2160p",                                  // "ORG","2160p","1080p","720p","480p", etc.
  "provider": "Febbox FID",
  "size": "81.90 GB",                                  // or "Playlist (size N/A)"
  "linkDead": false,                                   // already filtered, but respect it
  "tag": "movie", "tags": ["movie"], "tagSource": "tmdb",
  "sourceTitle": "…",                                  // provider's own label
  "episodeName": null, "description": null, "still": null, "airDate": null,
  "absoluteEpisode": null, "track": null,
  "language": null, "languageLabel": null,             // audio language if the provider declared it
  "container": "m3u8",                                 // "m3u8" | "mp4" | "mkv" | …
  "playableInBrowser": true                            // false for mkv/HEVC — DO NOT AUTO-PICK
}
```

Observed mix for one title: 36× `m3u8` (playable), 5× `mp4` (playable), 4× `mkv` (not playable,
H.265).

### 4.7 Streams — live SSE feed (optional but recommended for fast time-to-first-frame)

```
GET /api/streams/:type/:tmdbId/live      (Accept: text/event-stream)
Events (SSE):
  event: meta    → { ... }
  event: status  → per-provider status update
  event: stream  → raw provider output arriving early (partial rows)
  event: done    → the COMPLETE, enriched, link-checked payload (same shape as 4.6)
  event: error   → { ... }
```

Use it to render the first playable row at ~2–3s and fill in the rest; the `done` frame supersedes
everything. If SSE is too much work for a "quick" build, polling `GET /api/streams/...` once is
acceptable.

### 4.8 Streams — single provider

```
GET /api/streams/:provider/:type/:tmdbId[?season=&episode=]
→ same payload shape as 4.6, restricted to one provider.
```

### 4.9 Providers

```
GET /api/providers
→ { "success":true, "providers":[ {"name":"4khdhub","enabled":true},
     {"name":"showbox","enabled":true}, {"name":"anime","enabled":true}, ... ] }
```

### 4.10 Media proxy routes (you usually never call these directly)

Returned `stream.url` values already point here; hls.js/video just fetch them.

```
GET /m3u8-proxy?url=<encoded>&headers=<encoded-json>   // rewrites playlist, rewrites child URIs
GET /ts-proxy?url=<encoded>&headers=<encoded-json>     // .ts segments / mkv / mp4 bytes; supports Range
GET /sub-proxy?url=<encoded>                           // subtitles
```

### 4.11 Endpoints that DO require a session (you don't need them)

`POST /api/config`, `POST /auth/change-password`, `GET /api/debug/env`. The frontend needs none of
these. `GET /api/config` is public but you can ignore it.

---

## 5. Behavior to replicate (feature list)

1. **Home / Discover**
   - Grid of trending titles (poster, title, year, rating). Infinite-ish rows are optional; one
     "Trending" grid is enough for a quick build.
   - Search box (debounced) → grid of results. Clicking a title opens the detail view.
2. **Detail view**
   - Backdrop, poster, title, year, rating, genres, overview.
   - **Play** button. For series, a season dropdown (from `seasonCount`) and an episode list
     (from the episodes endpoint) — clicking an episode plays it.
3. **Playback**
   - On Play, fetch streams, **auto-select the best stream**, and **autoplay** in an in-page
     player. "Best" = highest `quality` among rows with `playableInBrowser !== false` and
     `linkDead !== true`; break ties by provider reputation if you like. Prefer `m3u8`/`mp4`.
   - Full-window player: `<video>` fills the window on a true-black background, controls hidden
     until the pointer moves.
   - Loading spinner while the first frame buffers; clear it on `playing`.
4. **Streams drawer (manual override)**
   - A **"Streams"** button, revealed on **hover** near the player controls (or always visible in a
     corner — hover to reveal is the spec). Opens a panel listing every row with
     provider / quality / container / size / language badges.
   - Browser-incompatible rows (`playableInBrowser === false`) are shown **greyed/disabled** with a
     "not playable in browser" badge.
   - Selecting a row **switches the source and preserves the current playback position** (seek the
     new source to `video.currentTime` after `loadedmetadata`).
   - Nothing is hidden: show the quality/sort logic as badges, don't silently reorder without
     telling the user.
5. **Position memory / resume**
   - Persist `{ type, id, season, episode, positionSeconds, updatedAt, title, poster }` in
     `localStorage` on timeupdate (throttled) and on unload.
   - A "Continue Watching" row on the home page built from that store; clicking resumes at the saved
     position. Resume on play if the same title/episode is reopened.
6. **Up-next / auto-advance (series)**
   - When playback nears the end (`duration - currentTime < ~30s`, or on `ended`), show a
     "Next episode" prompt; auto-advance if the user has it enabled, else show a card with a
     countdown. Next episode = next item in the episodes list.
7. **Stall handling — "offer, don't auto-switch"**
   - Detect a stall: `waiting` event, or `buffered` not advancing while `readyState < 3` for
     several seconds.
   - Instead of silently switching sources, show a non-blocking banner/card: *"Playback looks stuck
     — try another stream?"* with buttons **Switch** (open the Streams drawer) and **Dismiss**.
   - **Never auto-switch mid-play.** Auto-switch is the classic bug that strands the user on a
     different source.
   - Suppress the offer when the cache/buffer is genuinely filling (bytes are arriving) — only
     offer when the source is actually starved (frozen or crawling at <~0.35× real time over a
     ~20s window).
8. **Keyboard / Esc semantics**
   - `Esc` dismisses an open stall banner first; if none, `Esc` collapses the full player to a
     **mini-player**; if already mini, `Esc` **stops playback and saves the position**.
   - Space = play/pause, ←/→ = seek ±10s, `f` = fullscreen, `m` = mute.

---

## 6. UI / visual spec

- **Theme:** true black (`#000`) surfaces; text and accents in neutral white (`#fff` and greys,
  e.g. `#b3b3b3` for secondary). No colored accent chrome. Subtle 1px hairline borders
  (`rgba(255,255,255,0.08)`), 8–12px radii, generous spacing.
- **Typography:** system UI stack (`-apple-system, system-ui, "Segoe UI", Roboto, sans-serif`).
  Title text large and light-weight; metadata small and grey.
- **Cards:** poster aspect 2:3, rounded, hover = slight scale + brightness lift.
- **Player:** full bleed; a top gradient scrim for the title/back with a `✕` (stop + save
  position); bottom gradient scrim for controls; controls auto-hide after ~3s of no pointer
  movement.
- **Mini-player:** when collapsed, a **400×225** fixed card in the bottom-right showing the video
  with a thin progress bar; clicking expands back to full; `✕` stops and saves.
- **Streams drawer:** slides in from the right (or bottom sheet on narrow screens), lists rows with
  badges (`2160p`, provider name, `MKV · not playable`, language). Highlight the active row.
- Accessibility: focus-visible outlines, `aria-label`s on icon buttons, captions/subtitles via a
  `<track>` when `sub-proxy` URLs are available.

---

## 7. Suggested file structure (static, no build)

```
web/
├── index.html        # home + search + detail + player views (or use a tiny router)
├── styles.css        # true-black theme
├── app.js            # routing, API calls, state, continue-watching, stall logic
└── player.js         # hls.js wrapper: load(stream) -> <video>, position preserve, stall detect
```

Load hls.js from a CDN, e.g.:

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
```

### Minimal playback sketch (hls.js)

```js
function playStream(video, streamUrl, atSeconds = 0) {
  const isHls = /\.m3u8/i.test(streamUrl) || streamUrl.includes('m3u8-proxy');
  if (video._hls) { video._hls.destroy(); video._hls = null; }

  if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
    const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    video._hls = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (atSeconds > 0) video.currentTime = atSeconds;
      video.play().catch(() => {}); // user gesture may still be required
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) showStallOffer();          // offer, never auto-switch
    });
  } else {
    video.src = streamUrl;                          // mp4, or Safari native HLS
    video.addEventListener('loadedmetadata', () => {
      if (atSeconds > 0) video.currentTime = atSeconds;
      video.play().catch(() => {});
    }, { once: true });
  }
}
```

**Autoplay note:** browsers block unmuted autoplay without a user gesture. Because the user clicks
**Play**, playback normally starts allowed. If the browser still blocks it, show a big play button
and start on the next click.

---

## 8. Acceptance tests (how to know it works)

Assume the API is running on `:8787` and the frontend on `:5500`.

1. `curl http://localhost:8787/api/health` returns `"ok": true`.
2. Home page shows a trending grid with working poster images.
3. Search "spiderman" → results appear; open the first result → detail page renders.
4. Click **Play** → video starts within a few seconds, English audio (best effort), controls appear
   on hover.
5. Open the **Streams** drawer → rows list with quality/provider/container badges; MKV rows show as
   not playable; selecting a playable row switches source **without losing position**.
6. Reload the page → "Continue Watching" shows the title and resumes near the saved position.
7. For a series, reaching the end shows the **Next episode** prompt.
8. Kill the API (`Ctrl-C`) → the site shows an offline banner rather than hanging.
9. Force a stall (throttle the network in devtools) → a *"Playback looks stuck"* offer appears and
   **does not** switch sources by itself.

Reference checks against the API:

```bash
curl -s http://localhost:8787/api/health
curl -s "http://localhost:8787/api/search?q=spiderman" | python3 -m json.tool | head -40
curl -s "http://localhost:8787/api/streams/movie/969681" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["count"],"streams");
from collections import Counter;print(Counter(s["container"] for s in d["streams"]))'
# expect e.g. 45 streams / Counter({'m3u8':36,'mp4':5,'mkv':4})
curl -s "http://localhost:8787/api/metadata/series/1399/episodes?season=1" | python3 -m json.tool | head -30
```

A known-good movie ID for testing: **969681** (*Spider-Man: Brand New Day*).
A known-good series for episode testing: **1399** (*Game of Thrones*), season 1.

---

## 9. Out of scope / do NOT

- **Do not modify the Node backend** (routes, proxy, providers). If something is missing, note it
  and ask; don't reinvent it in the frontend.
- **Do not try to play MKV/HEVC** streams in the browser or promise cross-browser 4K H.265.
- **Do not auto-switch streams** on a stall — offer instead.
- **Do not hardcode** a `127.0.0.1`/`localhost` mix; derive the API base from a single constant and
  keep the page origin consistent with it.
- **Do not serve from `file://`**; an `http` origin is required for fetch and media.
- Keep it dependency-light; a CDN hls.js is the only external library you should need.

---

## 10. Nice-to-haves if time allows

- SSE live feed for near-instant first playable row.
- Subtitles via `sub-proxy` as `<track>` elements.
- Remember last-used volume/mute in `localStorage`.
- Keyboard shortcuts overlay (`?`).
- A small "server status" dot driven by `/api/health`, polled every ~15s.
