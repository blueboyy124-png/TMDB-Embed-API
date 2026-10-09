# 🍿 TMDB Embed API

> Modern, configurable streaming metadata + source aggregation API with a secure admin panel and multi-key TMDB rotation.

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-brightgreen?style=flat" />
  <img src="https://img.shields.io/badge/Status-Active-success?style=flat" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat" />
  <img src="https://img.shields.io/badge/Version-1.3.0-informational?style=flat" />
  <img src="https://img.shields.io/docker/pulls/inside4ndroid/tmdb-embed-api?label=Docker%20Pulls&style=flat" />
</p>

---

## 📸 Screenshots
<p align="center">
  <img src="screenshots/Screenshot 2025-09-16 174931.png" width="46%" />
  <img src="screenshots/Screenshot 2025-09-16 175002.png" width="46%" />
</p>
<p align="center">
  <img src="screenshots/Screenshot 2025-09-16 175008.png" width="46%" />
  <img src="screenshots/Screenshot 2025-09-16 175013.png" width="46%" />
</p>
<p align="center">
  <img src="screenshots/Screenshot 2025-09-16 175020.png" width="46%" />
  <img src="screenshots/Screenshot 2025-09-16 175026.png" width="46%" />
</p>
<p align="center">
  <img src="screenshots/Screenshot 2025-09-16 175033.png" width="46%" />
  <img src="screenshots/Screenshot 2025-09-16 175040.png" width="46%" />
</p>

---

## ✨ Features
- **13 Built-in Providers** – Showbox/FebBox, 4KHDHub, VixSrc, Videasy, Vidlink, DahmerMovies, StreamFlix, VaPlayer, CastleTV, HDGharTV, NetMirror, OneTouchTV, ZXCStreams — with per-provider enable toggles + default selection.
- **Multi-TMDB Key Rotation** – Supply multiple API keys; one is chosen randomly per request.
- **🔥 Plugin System** – Drop new provider files in `providers/` and add its exported function to the registry map (`providers/registry.js` → `providerFunctionMap`). No core file edits required.
- **Dynamic Filtering** – Minimum quality presets, custom JSON quality map, codec exclusion rules (presets + JSON).
- **Runtime Overrides UI** – Fully interactive web admin at `/config.html` (login protected) writing to `utils/user-config.json`.
- **Session Auth + Rate Limiting** – Login system with brute-force lockouts, logout, and password change.
- **Status & Health Panel** – Live metrics, provider status, endpoint list, and per-provider functional checks (configurable check title via TMDB ID).
- **Config Propagation** – Overrides mirrored to `process.env` for legacy compatibility (no `.env` required after first save).
- **Back-Navigation Safe** – Cache-control + visibility/session revalidation.
- **Optional Stream Proxy Layer** – When enabled, rewrites returned stream URLs so HLS playlists, TS segments, and subtitles are served through internal endpoints (`/m3u8-proxy`, `/ts-proxy`, `/sub-proxy`) allowing uniform headers, origin shielding, and optional segment caching.
  When active the API omits per-stream `headers` objects from responses (they're no longer needed by clients) to avoid leaking upstream header requirements.

  Proxy Tuning Parameters (query flags accepted by `/ts-proxy` – defaults shown):
  - `clampOpen` (on) – If a client sends an ambiguous `Range: bytes=0-`, constrain it to an initial window of `openChunkKB` (default 4096 KB) to avoid huge first reads.
  - `openChunkKB=4096` – Size (KB) used for both clamp window and each progressive expansion increment.
  - `progressiveOpen` (on) – Grow successive ambiguous head requests (`bytes=0-`) incrementally instead of one large span. Maintains a per-URL expansion map.
  - `initChunkKB=512` – Size used for a synthetic initial partial (206) when no client range is provided and progressive growth is disabled. Capped 64–2048 KB.
  - `noSynth=1` – Disable synthetic initial partial generation (forces pass-through behavior).
  - `force200=1` – Normalize upstream 206 responses to 200 (diagnostics / edge player testing).
  - `tailPrefetch` (on) – Enable asynchronous tail fetch of the file's last bytes to satisfy rapid player tail probes.
  - `tailPrefetchKB=256` – Tail window size (64–2048 KB). Cached in memory with TTL cleanup.
  Behavior Notes:
  - Synthetic partials auto-disable when `progressiveOpen` is active (real progressive ranges preferred).
  - Player tail probes (e.g., VLC metadata scans) are accelerated by the cached tail window.
  - Forced 200 mode strips `Content-Range` to emulate full responses for troubleshooting.
  - Host Overrides: `pixeldrain.*` and `video-downloads.googleusercontent.com` URLs are routed through `/ts-proxy` regardless of extension to ensure correct range + MIME handling.

---

## 📦 Quick Start
```bash
# 1. Install dependencies
npm install

# 2. (Optional) Copy example env if you want an initial TMDB key
cp .env.example .env   # then edit TMDB_API_KEY=

# 3. Start API with automatic restarts (recommended for local dev)
npm start

# Or production-style single run
# node apiServer.js

# 4. Open the Admin UI (login page) in browser
http://192.168.86.75:8787/

# 5. Health check
curl http://192.168.86.75:8787/api/health
```

**Default credentials (first run):** `admin` / `change-me` — **change them immediately** from the dashboard or via `POST /auth/change-password`.

---

## 🐳 Docker Usage

### Pull & Run (Fastest)
If you just want to run it (no building):
```bash
docker pull inside4ndroid/tmdb-embed-api:latest
docker run --name tmdb-embed-api -p 8787:8787 \
  -e TMDB_API_KEY=YOUR_TMDB_KEY \
  inside4ndroid/tmdb-embed-api:latest
```

Or the minimal quick-test run:
```bash
docker run -it -p 8787:8787 inside4ndroid/tmdb-embed-api:latest
```

Persist overrides (Windows PowerShell example) by mounting a local file:
```powershell
New-Item -ItemType File -Path .\utils\user-config.json -Force | Out-Null
docker run --name tmdb-embed-api -p 8787:8787 `
  -e TMDB_API_KEY=YOUR_TMDB_KEY `
  -v ${PWD}/utils/user-config.json:/app/utils/user-config.json `
  inside4ndroid/tmdb-embed-api:latest
```

### Build Locally
```bash
docker build -t tmdb-embed-api .
docker run --name tmdb-embed -p 8787:8787 \
  -e TMDB_API_KEY=YOUR_TMDB_KEY \
  -v "$(pwd)/utils/user-config.json:/app/utils/user-config.json" \
  tmdb-embed-api
```

After first login + save, the UI writes overrides into the mounted `user-config.json` so they persist across container restarts.

### docker-compose
An example `docker-compose.yml` is included (healthcheck + `restart: unless-stopped`). Start with:
```bash
docker compose up -d --build
```
Environment variables can be supplied via a `.env` file in the same directory (Compose automatically loads it). Example `.env`:
```
TMDB_API_KEY=first_key
```

To stop & remove:
```bash
docker compose down
```

### Switching to Multiple TMDB Keys
Either set `TMDB_API_KEYS` to a JSON array string:
```bash
docker run -p 8787:8787 \
  -e TMDB_API_KEYS='["KEY1","KEY2","KEY3"]' \
  tmdb-embed-api
```
or add / remove keys inside the Admin UI (Keys panel) and save.

If both `TMDB_API_KEY` and `TMDB_API_KEYS` are provided, rotation uses the array. Clearing the array in the UI also clears the legacy key.

### Key Environment Variables
| Variable | Purpose | Notes |
|----------|---------|-------|
| `API_PORT` | Port the server listens on | Defaults to `8787` |
| `BIND_HOST` | Interface to bind | Defaults to `0.0.0.0` |
| `TMDB_API_KEY` | Single TMDB key (legacy) | Use if you only have one key |
| `TMDB_API_KEYS` | JSON array of keys | Overrides single key when present |
| `DEFAULT_PROVIDERS` | Comma-separated default providers | Used by the aggregate endpoint |
| `DEFAULT_REGION` / `FEBBOX_REGION` | Default region | Passed through for legacy compat |
| `MIN_QUALITIES` | Min quality setting / JSON | Mirrored to the config model |
| `EXCLUDE_CODECS` | Codec exclusion JSON | e.g. `{"excludeDV":true}` |
| `FEBBOX_COOKIES` | FebBox JWT cookie(s) | Comma-separated; required for Showbox |
| `ENABLE_<PROVIDER>_PROVIDER` | Per-provider enable flags | e.g. `ENABLE_4KHDHUB_PROVIDER=true` |
| `DISABLE_CACHE` | Disable internal caches | `true`/`false` |
| `ENABLE_PSTREAM_API` | PStream API flag | Default `true` |
| `DISABLE_URL_VALIDATION` | Skip general URL checks | Default `false` |
| `DISABLE_4KHDHUB_URL_VALIDATION` | Skip 4khdhub URL checks | Default `false` |
| `ENABLE_PROXY` | Mount proxy routes | Default `false` |
| `PROVIDER_TIMEOUT_MS` | Hard per-provider ceiling | Default `45000`; `PROVIDER_TIMEOUT_<NAME>_MS` per provider |
| `AGGREGATE_SOFT_DEADLINE_MS` | Soft deadline for the aggregate endpoint | Default `20000`; also `?deadline=ms` per request |
| `AGGREGATE_ENOUGH_STREAMS` | Streams needed before the aggregate returns early | Default `12`; `&wait=1` per request opts out |
| `AGGREGATE_ENOUGH_PROVIDERS` | **Distinct** providers needed for that early return | Default `3` |
| `4KHDHUB_VALIDATION_CACHE_MS` | How long a validated 4khdhub link is trusted | Default `3600000` (1h); links are presigned for 8h |
| `PROVIDER_CHECK_TMDB_ID` | Title for dashboard functional checks | Default `278` |
| `SHOWBOX_CACHE_DIR` | Custom Showbox cache directory | Optional |
| `NETMIRROR_API_BASE` | NetMirror embed base URL | Optional override |
| `NETMIRROR_STREAM_REFERER` | NetMirror stream Referer header | Optional override |

### Updating the Image
```bash
docker compose pull   # if using an external registry (future)
docker compose up -d --build
```

### Restart from Admin UI
The Admin panel includes a Restart Server control.
- Local (nodemon): the backend writes a `restart.trigger` file and exits; nodemon detects the change and restarts automatically.
- Docker Compose: the container exits and is restarted by `restart: unless-stopped`.

### Healthcheck
Container health relies on `GET /api/health`. If you disable or modify that route, adjust the Dockerfile / compose healthcheck accordingly.

---

## 🔐 Authentication
The root (`/`) serves the login page. After successful login a session cookie (`session`) is issued (HttpOnly; 12h lifetime). All admin pages (e.g. `config.html`) require an active session.

Credentials are stored in `utils/auth-users.json` (auto-created on first run with `admin` / `change-me`). Passwords are hashed with PBKDF2-SHA512 (100,000 iterations, random salt). There is no `PASSWORD_HASH` / `ADMIN_USERNAME` environment override — manage users directly in this file or via the change-password endpoint.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/auth/login` | POST | Authenticate (JSON: `{ username, password }`) |
| `/auth/logout` | POST | Destroy session |
| `/auth/session` | GET | Check session status |
| `/auth/change-password` | POST | Update password (requires session) |

Repeated failed logins trigger escalating lockouts (`Retry-After` header emitted; 5 attempts per window).

---

## 🛠 Configuration Model
All runtime state collapses into a *merged* object displayed in the UI (Live Config panel). Source order:
1. Initial environment variables / optional `.env`
2. JSON overrides: `utils/user-config.json`

Saving in the UI writes only changed keys. Setting a field to empty removes the override (reverting to env/default). Removing all TMDB keys (and saving) clears `tmdbApiKeys` and the legacy `tmdbApiKey`.

**Override File:** `utils/user-config.json`
```json
{
  "defaultProviders": ["4khdhub"],
  "tmdbApiKeys": ["KEY_A","KEY_B"],
  "enable4khdhubProvider": true,
  "providerCheckTmdbId": "278"
}
```

---

## 🎛 Admin UI Sections
| Panel | Summary |
|-------|---------|
| Core | Port, default providers, default region |
| Quality / Filters | Min quality presets & codec exclusion JSON |
| Keys | Add/remove TMDB API keys (rotated randomly) |
| Advanced | Provider toggles, cache & validation flags |
| Server Status | Live metrics, provider functional checks |
| Live Config | View merged + override JSON snapshots |

Session is revalidated on visibility and back/forward navigation to prevent stale access.

---

## 🔌 Providers
The API supports a plugin system. Drop a new provider file in the `providers/` folder and register its exported function in `providers/registry.js` under `providerFunctionMap`.

### Current Built-in Providers
- `showbox` - Showbox/FebBox streams (requires FebBox JWT cookie)
- `4khdhub` - 4KHDHub streams
- `vixsrc` - VixSrc streams
- `videasy` - Videasy streams (10 servers via enc-dec.app)
- `vidlink` - Vidlink streams
- `dahmermovies` - DahmerMovies streams (direct file links)
- `streamflix` - StreamFlix streams (direct MP4 links)
- `vaplayer` - VaPlayer streams (HLS via IMDb ID)
- `castletv` - CastleTV streams (AES-128 encrypted API)
- `hdghartv` - HDGharTV streams (title-matched search + IMDb verification)
- `netmirror` - NetMirror streams (Netflix direct + NewTV platform fallback)
- `onetouchtv` - OneTouchTV streams (AES-256 encrypted API)
- `zxcstreams` - ZXCStreams streams (multi-server backend, dynamic domain discovery)

Providers that rely on title resolution against TMDB (`castletv`, `hdghartv`, `onetouchtv`, `zxcstreams`, `vaplayer`, `netmirror`) require at least one TMDB API key configured.

### Adding a New Provider
1. **Create** `providers/yourprovider.js` with your stream fetching logic
2. **Export** a function like `getYourproviderStreams(tmdbId, mediaType, season, episode)`
3. **Register** it in `providers/registry.js` → `providerFunctionMap`:
   ```js
   // providers/registry.js
   const providerFunctionMap = {
     'Showbox.js': 'getStreamsFromTmdbId',
     '4khdhub.js': 'get4KHDHubStreams',
     'vixsrc.js': 'getVixsrcStreams',
     'videasy.js': 'getVideasyStreams',
     'vidlink.js': 'getVidlinkStreams',
     'dahmermovies.js': 'getDahmermoviesStreams',
     'streamflix.js': 'getStreamflixStreams',
     'vaplayer.js': 'getVaplayerStreams',
     'castletv.js': 'getCastletvStreams',
     'hdghartv.js': 'getHdghartvStreams',
     'netmirror.js': 'getNetmirrorStreams',
     'onetouchtv.js': 'getOnetouchtvStreams',
     'zxcstreams.js': 'getZxcstreamsStreams',
     'yourprovider.js': 'getYourproviderStreams'
   };
   ```
4. The provider will appear in the admin UI with an enable/disable toggle.

**Example Provider (Unified Output):**
```javascript
async function getYourproviderStreams(tmdbId, mediaType, season, episode) {
  // Your scraping/API logic here
  return [{
    name: "YourProvider",
    title: "Fight Club - 1080p [YourProvider #1]",
    url: "https://stream.url/video.mp4",
    quality: "1080p",
    provider: "yourprovider",
    headers: { "User-Agent": "Mozilla/5.0" }
  }];
}

module.exports = { getYourproviderStreams };
```

> **⚠️ Important**: All providers must return streams in the unified JSON format to ensure compatibility with filtering and aggregation.

The system automatically:
- ✅ Detects new provider files
- ✅ Adds enable/disable toggles in the admin UI
- ✅ Includes them in stream aggregation
- ✅ Applies filtering and quality controls
- ✅ No core file edits required!

---

## 📡 Key Endpoints
| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Basic heartbeat |
| `GET /api/metrics` | Runtime counters & summary |
| `GET /api/status` | Metrics + providers + endpoints + `providerCheckTmdbId` |
| `GET /api/providers` | All providers with enabled status |
| `GET /api/providers/:name` | Single provider status |
| `GET /api/streams/:type/:tmdbId` | Aggregate streams (`type` = movie\|series; supports `?season=&episode=&deadline=&perStreamMeta=`) |
| `GET /api/streams/:provider/:type/:tmdbId` | Provider-specific streams (same query params) |
| `GET /api/metadata/:type/:tmdbId` | Merged TMDB + AniList title metadata |
| `GET /api/metadata/:type/:tmdbId/episodes` | Episode list with numbering details (`?season=`) |
| `GET /api/config` | `{ merged, override, overridePath }`. Secret values are **masked**; presence is reported via `hasTmdbApiKeys` / `hasFebboxCookies` |
| `POST /api/config` | Apply override patch (persisted to `utils/user-config.json`). **Requires a session** — it changes server behaviour for everyone |
| `GET /api/debug/env` | Debug environment/config snapshot. **Requires a session**; the selected FebBox cookie is masked |
| `POST /api/restart` | Graceful restart (writes `restart.trigger` + exits) |

Proxy routes (mounted only when `enableProxy` is on):
| Endpoint | Description |
|----------|-------------|
| `GET /m3u8-proxy?url=...&headers=...` | Rewrites & serves HLS playlists/segments |
| `GET /ts-proxy?url=...&headers=...` | Range-aware file/segment proxy |
| `GET /sub-proxy?url=...` | Subtitle passthrough proxy |

The aggregate endpoint auto-resolves IMDb when needed, merges all enabled (or `defaultProviders`) provider output, then applies filtering. Provider timing is returned per provider (`providerTimings`).

> **Testing by hand:** open `http://<host>:8787/test-player.html`. Pick a **type** (TV/anime series or movie), a **TMDB id** and — for a series — a season and episode, or click one of the presets (anime / TV / films). It reports three things at once:
> - **how fast** — total ms, with `stopReason` so a deliberate early return is not mistaken for a timeout
> - **which sources** contributed — a lone provider is flagged inline as "no redundancy if it goes down"
> - **whether all the data arrived** — a per-field checklist (title, description, still, date, absolute #, tag, AniList), so "it worked but has no description" looks different from "it fully loaded"
>
> It then lists every stream with a Play button and logs why anything fails. MKV rows are disabled with the reason given, because no browser decodes MKV and a dead button is worse than an honest one. "Fill from TMDB ID" asks the API what an id actually is, so a wrong type or stale season is corrected before you wait rather than after; invalid input is refused in the page instead of becoming a 20s round trip to a 400.
>
> **Writing your own player?** Detect HLS with *both* patterns:
> ```js
> function isHlsUrl(u) {
>   if (typeof u !== 'string') return false;
>   return /\.m3u8(\?|#|$)/i.test(u) || /\/m3u8-proxy(\?|$)/i.test(u);
> }
> ```
> With `enableProxy` on, every stream is rewritten to `<host>/m3u8-proxy?url=...` and **`m3u8-proxy` has no dot before `m3u8`**, so a bare `/\.m3u8/` test never matches. You then hand an HLS playlist to `<video src>`, Chrome cannot decode it, and the symptom is controls with `0:00` and no error. The same misjudgement also breaks stream ranking and `.mkv` detection. `public/player.html` (INTEGRATION NOTE A) and `public/resolver.js` carry the same helper — keep the copies in sync.

### Soft deadline (partial results)

The aggregate is not held hostage by its slowest provider. It answers after `AGGREGATE_SOFT_DEADLINE_MS` (default **20000**) with everything that has arrived so far:

```json
{
  "count": 28,
  "partial": true,
  "pending": ["4khdhub", "anime"],
  "providerStatus": { "vixsrc": "ok", "4khdhub": "pending" },
  "timings": { "totalMs": 8157, "providersMs": 8153, "deadlineMs": 8000, "settled": 11, "providerCount": 14 }
}
```

- `partial: true` means some providers had not finished; their streams are simply **not** in that response, so re-request with a larger budget to collect them.
- `providerStatus` is per provider: `ok` | `empty` | `timeout` | `error` | `disabled` | `pending`.
- `?deadline=ms` overrides per request (clamped to 2s–45s), e.g. `/api/streams/series/1429?season=2&episode=1&deadline=40000`.

### Early return once the answer is good

The soft deadline is the "too long" limit, but waiting it out when the response was already complete is just
as bad as having no limit at all — a 26-title sweep had a **median of 12.6s and a p90 of 17.8s**, almost all of
it spent waiting on providers long after 30+ playable streams were in hand.

So the aggregate returns as soon as it has `AGGREGATE_ENOUGH_STREAMS` (12) from `AGGREGATE_ENOUGH_PROVIDERS`
(**3, and the distinct count is the point** — three providers returning one stream each is three chances to
be wrong, and would defeat the purpose of aggregating 14 of them).

Measured over the same 26 titles: **median 12,647ms → 2,260ms, p90 17,821ms → 6,291ms**, coverage unchanged at
26/26.

- `stopReason` on the response says why it left: `complete`, `enough` (left early on purpose — **not** a
  timeout), or `deadline` (genuinely ran out of time). Note `partial: true` now accompanies a deliberate early
  return too, so use `stopReason` rather than `partial` to distinguish.
- `&wait=1` waits for every provider regardless.

### Per-episode metadata

The episode's name, description, still, air date and absolute number are **identical on every stream in a
response**, so they are not repeated per stream. They are served once:

- aggregate: `metadata.episode` (unchanged, already existed)
- per-provider: a top-level `episode` object

`?perStreamMeta=1` puts them back on every stream for clients that want the older shape. The keys stay
present-and-null by default, so reading `stream.description` never throws. This is ~28% of the payload; with
gzip on top, a 21-stream response went from 34KB to 4.9KB.

### Browse and search

The API is no longer streams-only — a client no longer has to already know a TMDB id.

| Endpoint | Description |
|---|---|
| `GET /api/search?q=` | TMDB multi search. `&page=1..10`. Returns `{ query, totalResults, results[] }` trimmed to what a picker renders |
| `GET /api/trending` | `?window=day\|week` (default `week`) |

Each result is `{ id, type: movie\|series, title, overview, poster, year, rating }`. Both are cached with the
same bounded cache and share the same TMDB 429 cool-off as every other TMDB call, so a search box that fires
a request per keystroke cannot rate-limit the server. A TMDB rate limit answers `503 UPSTREAM_RATE_LIMITED`
rather than an empty result set — an empty grid reads as "no such title" and sends you looking for a typo.

### Stream playback facts

`container` and `playableInBrowser` are now set on every stream, centrally in `utils/streamMeta.js`.

Both fields were previously **absent from every response**, and since clients test `playableInBrowser !== false`,
an absent field read as "yes, playable" — so 2160p MKV streams were advertised as playable. On one movie that
was **5 of 12 streams**, including the only 4K one. Matroska cannot be decoded by any browser or any Roku, so
those all ended in a black screen. Clients that rank on `playableInBrowser === false` (including
`my-anime-site`, which applies a 100000 penalty on it) had that penalty silently never fire.

`container` is `m3u8`, `mp4`, `mkv`, … and is derived through the proxy URL, because with `enableProxy` the
client only ever sees `<origin>/ts-proxy?url=<encoded .mkv>`.

### Link health — dead links are no longer handed out

`utils/linkHealth.js` probes every stream before the response is sent and drops the ones that do not work.

This fixes a bug that made two separate symptoms look like one thing. Providers return *links*, not playable
files. DahmerMovies answered with **five streams per title, all HTTP 403** — an expired presigned URL — and
Vidlink and VaPlayer had their own variants. Nothing noticed, so a response looked healthy (12 streams, 5 of
them advertised as 4K) and only failed when you pressed play. Because the dead entries were the 4K ones, they
sat at the top of the list *looking like the best options*. That is why "the provider gets nothing" and "it
doesn't look 4K" turned out to be the same defect: the real 2160p from Febbox was playable the whole time,
buried under dead 4K rows from a provider that was serving nothing.

- **Probed, then dropped.** `HEAD` first, and a ranged `GET` fallback when a server answers 405 to `HEAD`
  (which would otherwise read as a dead link).
- **Cached, so it is cheap.** 10 minutes per verdict, in a bounded cache. A repeat request for the same title
  costs nothing. The TTL is deliberately short: Vidlink alternates between 200 and 429, so a long "alive" TTL
  freezes one lucky moment and hands out dead links for the rest of the hour.
- **Circuit breaker.** A provider is skipped entirely for 10 minutes once **3 of its probed links are ≥80% dead**.
  It needs a *proven* failure — one bad link never disables anything, and a healthy provider is never accused.
  Both DahmerMovies and VaPlayer now trip and are skipped, which also removes their latency.
- **Manifests are probed too.** That was originally wrong and the test caught it: VaPlayer returns `.m3u8`
  manifests the proxy answers with 500, and skipping them let three dead streams survive on every title.
- Responses carry `linkCheck: { checked, dead, cached, byProvider }`. **`dead > 0` is healthy** — it means the
  API is not handing you links that 403. `byProvider` names who, which is how "this site is down" is told
  apart from "this site doesn't carry this title".

Set `LINK_ALIVE_TTL_MS`, `LINK_PROBE_TIMEOUT_MS`, `LINK_BREAKER_RATIO`, `LINK_BREAKER_COOLDOWN_MS` to tune, or
disable with `verifyLinkHealth: false`.

### Season/episode validation

`season` and `episode` must be plain non-negative integers, and must be supplied together. Season `0` is
allowed (TMDB uses it for specials). Anything else — `abc`, `-5`, `2.5`, `1e3`, `0x10` — is rejected with
`400 INVALID_SEASON_EPISODE` rather than falling back to season 1, which used to return streams for the wrong
episode while reporting `success: true`.
- `AGGREGATE_SOFT_DEADLINE_MS` changes the default. The hard per-provider ceiling is separate (`PROVIDER_TIMEOUT_MS`, default 45000, or `PROVIDER_TIMEOUT_<NAME>_MS` per provider) and still applies, so one hung provider cannot stall a response indefinitely.

---

## 🧪 Stream Object Schema (Unified)
```json
{
  "name": "ProviderDisplay",
  "title": "Fight Club - 1080p [YourProvider #1]",
  "url": "https://stream.url/video.mp4",
  "quality": "1080p",
  "provider": "yourprovider",
  "tag": "anime",
  "tags": ["anime"],
  "tagSource": "provider",
  "title": "The Land of Wano! To the Samurai Country where Cherry Bloss…",
  "sourceTitle": "One Piece S21E01 (1999) 1080p | 2.05 GB | Castle",
  "episodeName": "The Land of Wano! To the Samurai Country where Cherry Blossoms Flutter!",
  "description": "A mysterious country, a rampaging slasher, ancient samurai rituals of seppuku...",
  "still": "https://image.tmdb.org/t/p/w300/bCkiDB9SmyXGozQyJfk7jzlC5iD.jpg",
  "airDate": "2019-07-07",
  "absoluteEpisode": 892,
  "track": "sub",
  "language": "ja",
  "languageLabel": "Japanese",
  "headers": { "User-Agent": "Mozilla/5.0" },
  "subtitles": [ { "url": "https://.../en.srt", "lang": "English" } ]
}
```
- `name` / `title` – display strings (often include quality/source hints).
- `url` – direct upstream URL (or proxied URL when `enableProxy` is on).
- `quality` – e.g. `Auto`, `1080p`, `720p`, `480p`, `4K`. Missing/unknown qualities parse as `0`.
- `headers` – optional upstream request headers (stripped when proxying).
- `subtitles` – optional embedded subtitle tracks (CastleTV, NetMirror, OneTouchTV, Showbox).

### Episode metadata (every provider, same fields)

Every stream — from the anime provider, 4khdhub, CastleTV, anything — carries the same episode metadata, derived from TMDB rather than from whichever site produced the link. That is what makes the same episode read identically no matter where the stream came from.

- `title` – **the episode name**, truncated to 60 characters. It is only set when an episode name is actually known, so a **movie**, or an episode TMDB has not named, keeps the provider's own title. A title is never blanked.
- `sourceTitle` – the provider's original title, verbatim. Nothing is lost by the replacement above: `4.8 GB | Remux AAC 2 0` and `2.05 GB | Castle` survive here.
- `episodeName` – the full, untruncated name. `null` for movies.
- `description` – the **episode** synopsis, not the show's. `null` when TMDB has none; it is never filled in with the show blurb and passed off as the episode's.
- `still`, `airDate`, `absoluteEpisode` – episode thumbnail, air date, and the flat number anime sites use.
- `track` / `language` / `languageLabel` – the **audio** track. The anime provider's `sub` maps to `ja`/Japanese and `dub` to `en`/English, because that is the convention for a Japanese-original title. Anything the source does not declare stays `null` rather than being guessed — most providers say nothing, so a correct `null` is more useful than a wrong guess. This is the audio language and is separate from `subtitles` below.

### Tags

Every stream carries a `tag` so a client can group sources without re-deriving what a title is:

- `anime` – anime. Streams from the `anime` provider are **always** tagged `anime` (it resolves links through anime numbering and AniList, whatever TMDB thinks the title is). Every other provider is classified through TMDB: an anime title's streams from ordinary providers are tagged `anime` too, so they group together.
- `movie` / `tv` – the media type.
- `tagSource` says who decided: `provider` (the anime provider), `tmdb` (TMDB's genre/language check) or `request` (only the media type could be claimed, because TMDB had not answered). A stream is never tagged on a guess — with no information it stays untagged.
- `tagCounts` on the response is a quick summary, e.g. `{ "anime": 12, "tv": 4 }`.

Filtering passes through `applyFilters` to enforce min quality + codec exclusions (see below).

> Note: When the `enableProxy` flag is turned on, provider-specific request headers are stripped from each stream object before responding. Clients should use the proxied URL directly without adding custom Referer/Origin headers.

---

## ⚙️ Configuration Flags (Advanced Panel)
| Flag | Default | Purpose |
|------|---------|---------|
| `enable<Name>Provider` | true | Enable/disable a provider (e.g. `enableCastletvProvider`) |
| `disableCache` | false | Disables internal caches |
| `enablePStreamApi` | true | PStream API flag |
| `disableUrlValidation` | false | Skip general URL pattern validation checks |
| `disable4khdhubUrlValidation` | false | Skip 4khdhub-specific URL validation |
| `enableProxy` | false | Mounts proxy routes and rewrites stream URLs through them |
| `providerCheckTmdbId` | `278` | TMDB ID used by dashboard functional checks |
| `showboxCacheDir` | — | Custom Showbox cache directory |

Toggle `enableProxy` to activate the internal proxy. This adds lightweight playlist/segment/subtitle rewriting without modifying provider code. Disable it to return direct upstream URLs.

---

## 🧩 Quality & Codec Filtering
- Presets: `all`, `480p`, `720p`, `1080p`, `1440p`, `2160p`.
- Custom quality JSON example (runtime applies the `default` entry; per-provider keys are preserved for future use):
```json
{ "default": "900p" }
```
- Quality strings are normalized numerically — `Auto` ≈ 1080, `HD` ≈ 720, `SD` ≈ 480, plus `4K`/`2160`, `1440`, `1080`, `720`, `576`, `480`, `360`, `240`.
- Codec exclusion JSON example:
```json
{ "excludeDV": true, "excludeHDR": false }
```

---

## 📊 Server Status & Functional Checks
The **Server Status** panel shows live metrics, the endpoint list, and a per-provider functional check table:

- **Run Provider Functional Checks** – hits `/api/streams/:provider/movie/:tmdbId` for each enabled provider and reports pass/fail with stream counts.
- **Provider check TMDB ID** – the title used for the checks is configurable in the dashboard (default `278` = *The Shawshank Redemption*). The value is persisted to `utils/user-config.json` and exposed via `/api/status` as `providerCheckTmdbId`.

---

## 🧪 Testing

| Command | What it does |
|---------|--------------|
| `npm run verify:numbering` | Episode-numbering rules, offline. Add `--live` to check against real TMDB/AniList. |
| `npm run verify:classify` | URL classification in the test player: all 12 shapes the API can return (offline, no server needed). |
| `npm run verify:cache` | Bounded cache eviction, offline. |
| `npm run verify:backoff` | That one TMDB failure produces one upstream retry, not fourteen (TMDB is stubbed; offline). |
| `npm run verify:concurrency` | That per-request state does not leak between users through globals. |
| `npm run verify:streammeta` | That episode metadata is uniform across providers, `sourceTitle` survives, and language is never guessed. |
| `npm run verify:streams` | Hits every enabled provider plus the aggregate for a title, reporting latency, stream counts and container mix. |
| `npm run verify:player` | Drives `public/test-player.html` in jsdom against a live server, asserting every proxied stream is classified as HLS. |
| `npm run verify:playerui` | Drives the same page's controls and verdict panel: an anime series, a movie, input rejection, presets. |
| `npm run verify:coverage` | Sweeps a 26-title catalogue and reports coverage per category, latency percentiles and single-source titles. `--quick` for one title per category. |
| `npm run verify:load` | **Multi-user load.** Many simultaneous users; asserts no timeouts, no errors, bounded memory, and that the proxy still serves real MPEG-TS afterwards. `--users N --rounds N`. |
| `npm run verify:lag` | **Jank meter.** Applies continuous load and reports event-loop lag. This is the number that explains "glitchy": while it is high, every timeout and deadline in the process is late by the same amount. `--users N --seconds N`. |
| `npm run verify:unit` | All six offline checks (no server needed). |
| `npm run verify` / `verify:all` | Everything / everything including the load test. |

For a one-off title:

```bash
node scripts/verify-streams.mjs --type series --id 1429 --season 2 --episode 1
node scripts/verify-load.mjs --users 16 --rounds 3
node scripts/verify-lag.mjs --users 12 --seconds 60
node scripts/verify-test-player.mjs            # BASE=http://host:port to point elsewhere
```

### Diagnosing slowness at runtime

`GET /api/health` reports the state that actually explains a slow or empty response:

| Field | Meaning |
|-------|---------|
| `tmdb.cooloffRemainingMs` | > 0 means TMDB rate-limited us and calls are being held back on purpose. |
| `tmdb.cachedLookups` | TMDB entries cached, against `tmdb.maxEntries`. |
| `admission` | `active`/`limit` providers running, `pending` waiting. Non-zero `pending` means users are queueing — intended, and the sign that you have more users than the process admits at once. |
| `eventLoop.p95Ms` | How late timers are firing. **The honest measure of jank**: while this is high, every deadline and timeout in the process is late by the same amount. Idle is ~0ms; hundreds is visible stutter. |
| `proxy` | Whether the proxy layer is actually mounted. |

Both `verify:streams` and `verify:player` need the server running. For a one-off title:

```bash
node scripts/verify-streams.mjs --type series --id 1429 --season 2 --episode 1
node scripts/verify-test-player.mjs            # BASE=http://host:port to point elsewhere
```

---

## 🔐 Security Notes
- Admin UI requires login; session cookie is HttpOnly.
- Cache-control headers disable storing sensitive pages.
- Login is rate limited with escalating lockouts (5 attempts per window).
- Password change endpoint enforces minimum length (8+).
- Default credentials (`admin` / `change-me`) are generated on first run — change them immediately.

---

## 🚀 Deployment Tips
| Aspect | Recommendation |
|--------|---------------|
| Node Version | 18+ LTS |
| Reverse Proxy | Terminate TLS (e.g., Nginx) and forward to API port |
| Persistent Config | Mount / persist `utils/user-config.json` |
| Auth Users | Persist `utils/auth-users.json` so credentials survive restarts |
| Logs | Pipe stdout to centralized logger |
| Scaling | Use a single instance unless providers are CPU bound |

For ephemeral platforms (e.g., Vercel) note that some providers use temporary directories; avoid enabling disk-heavy cache directories.

---

## 💡 Troubleshooting
| Symptom | Cause / Fix |
|---------|------------|
| TMDB quota issues | Add more keys under Keys panel |
| Provider missing in matrix | Ensure its enable flag exists & UI updated |
| Empty merged config after restart | `user-config.json` deleted or unreadable |
| Streams low quality | Adjust min quality preset or custom JSON |
| Showbox shows nothing | Provide `FEBBOX_COOKIES` (comma-separated) under Keys |
| Functional checks fail | Some providers 0-stream legit titles; try changing the *Provider check TMDB ID* |

---

## 🤝 Contributing
PRs welcome. Keep changes focused and avoid unrelated formatting churn. For new providers include:
- A short rationale
- Retry / timeout safeguards
- Respect for existing filtering structure

---

## ❤️ Sponsorship
If this project helps you, consider sponsoring to support continued development & maintenance:

<p align="center">
  <a href="https://github.com/sponsors/Inside4ndroid">
    <img src="https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?style=for-the-badge&logo=github-sponsors&logoColor=white" alt="Sponsor on GitHub" />
  </a>
</p>

Every contribution accelerates feature delivery & sustainability.

---

## 📜 License
MIT.

---

## 🙏 Acknowledgements
Inspired by community scraping/stream aggregation efforts. Credits also to the original NuvioStreamsAddon work for earlier concepts.

---

> *Happy streaming & hacking!* ✨

---