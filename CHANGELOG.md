# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **English audio first, original language always one click away.** Auto-play used to open dual-audio rows on whatever track the provider defaulted to (usually Hindi), which for a user who watches in English meant every first play was wrong. mpv now starts with `alang=en,eng`: a dual-audio file opens on its English track, and a file with no English track falls back to the file's own default (the original language) rather than failing. Settings → Audio holds the preference (English / Original, default English; Original drops `alang` and trusts the file).
  - The top bar shows what mpv **actually selected** — polled from `current-tracks/audio/lang` every 2s, not guessed from the row title — as a clickable chip; clicking cycles audio tracks, so the original language stays reachable without leaving the player.
  - The streams drawer marks languages honestly (English-capable `EN` in green, Hindi/Tamil/Telugu/Sub-only in orange, dual-audio `Multi`) and silently sorts English-capable + unnamed-language rows first — every row stays visible and manually pickable; nothing is hidden or filtered.
- **The stall offer now knows the difference between slow and dead.** mpv exposes `cache-speed` (a 1s-window bytes/sec measure); the banner requires it under 4 KB/s while cache-idle, so a healthy-but-slow source (tested end-to-end at 30 KB/s against a throttled local server for 45s) never raises it — bytes are still arriving, waiting beats switching — and an offer already on screen **retracts** when the source recovers before you act. Dead sources (`in=0 B/s`) still fire within 15s. The check logs `in=N B/s` so a firing is explainable from the log alone.
- **A 300 MiB demuxer buffer (≈1 minute of 4K)** with a 20s readahead, up from 150 MiB: on slow-but-alive CDNs the buffer refills instead of starving the decoder, which removes most of the spinner's reason to exist.
- **`POISON_SLOW=<n>` test hook**: rewrites n rows to a local server that bursts 1.5 MB then trickles (`slow_server.py`), which is what proved the suppression above; `OPEN_SETTINGS=1` opens Settings for screenshots.

### Changed
- **The buffering spinner got hysteresis on both edges** — ~1.5s of continuous underrun before it shows, ~2s of clean playback before it hides, immediate on pause. A micro-underrun no longer flashes it and a choppy stretch no longer blinks it. Before the first frame (and between `start()` and mpv attaching) it tracks immediately, because there the spinner *is* the loading indicator — and the attach window used to show chips over black with no indicator at all; that one-frame inconsistency is closed.
- **Playback clock split into a nested observable (`PlayerClock`)**: `pos`/`dur`/`buffering` update 2×/sec from the tick loop, and as `@Published` on the controller they re-rendered **every view in the window** (the controller is injected window-root) — the browsing grid re-diffing during playback was baseline jank. Only the scrubber and spinner observe the clock; everything else re-renders on real events only. This was the last piece of the "everything feels laggy" complaint that was structural rather than a specific bug.
- **The top bar tells the truth while loading**: entering the player from a detail page or Continue Watching sets `mode` before streams resolve, and the header said "Now playing" while the loading screen underneath it showed the real title. Both now use the same fallback chain (`context` → detail title), in both the header and the loading screen.
- **Image caching audited**: `ImageStore` (NSCache with count + cost caps, in-flight request dedup, disk-backed URLCache) is sound; no changes needed. Noted in the README's architecture section.

### Fixed
- **Resuming a film could silently restart it at 0:00.** Continue Watching resumed at the saved position, but if the first row died before its first frame (dead link the link-checker then dropped from the supersede payload), `refreshRows` moved the player to a clean row — and the row switch recomputed the carried position from mpv's `pos`, which was still 0 on a never-painted row, discarding the resume intent. The saved position now survives a row swap that happens before the first frame (a picture that *has* played still carries its own position, and a deliberate restart within 2s still carries 0).
- **"Silent deaths" in headless test runs were not an app bug**: the shell runner reaps background jobs when the launching command exits nonzero, so a launcher ending on a failing `grep` killed the whole process group mid-run — including the app under test, with no crash report and no log line. Test launches now exit 0 (see `macapp/README.md`).

- **Play determinism — MacStream no longer trusts a row it hasn't seen work.** The "Spider-Man won't play" bug was systemic: the live feed emits raw per-provider rows within ~2.5s, auto-play took `streams.first` from that preview, and when the first provider's links were dead at the CDN (Febbox signs its URLs and the signatures expire) the player spun forever while live rows sat unused below. Four layers close that hole:
  - **Preflight**: auto-play probes the top 10 candidate rows in parallel through the exact URLs mpv will use (≤1KB Range/playlist-head reads, 5s cap) and picks the first that answers 2xx with plausible content — playlists must actually look like playlists, because the proxy answers dead links with a JSON error. If every probe fails the list is still tried in order: a probe can lie, the player cannot.
  - **The `done` supersede**: the SSE feed's final event carries the complete, link-checked payload (dead links already probed out by `utils/linkHealth.js`) — the app was reading the event but keeping the raw preview rows forever. `done` now replaces the list wholesale (arrival times carried over), and `refreshRows` re-syncs a running player's row list on every arrival: the watchdog always gets real alternates, and a current row the link-checker dropped is moved to a clean row **only if it never painted** (an already-playing picture is never interrupted — the probe can lie, mpv cannot).
  - **First-frame watchdog**: no picture within 14s → advance with a quiet notice pill ("Row N wouldn't load — trying the next one…"), 3 strikes, then give-up: the player pauses and the streams drawer opens so the choice becomes manual. The bar is measured, not guessed — proxy-HLS first frames take ~10s end-to-end (verified with `mpv --frames=1`), so anything lower kills rows that were about to play, which would be the original bug inverted. The 15s stall offer went back to requiring a first frame: never-started rows are the watchdog's job, mid-play freezes remain offer-don't-auto-switch.
  - **Showbox liveness** (`providers/Showbox.js`): the existing size-probe wave now also probes HLS playlists — they were skipped entirely, which is exactly how dead shegu rows shipped as if fine — remembers definitive 4xx/5xx verdicts for 30 minutes (timeouts/network errors are NOT dead: a slow CDN is not a dead CDN), and sorts dead rows to the end instead of dropping them. `scripts/verify-showbox-liveness.mjs` — 11 checks over the probe, the marker TTL, and the sort.
  - Verified end-to-end on the bug title (TMDB 969681): the healthy path paints in ~10s after the supersede recovers from a partial-arrival pick; a refused row is skipped by preflight ("row 3 is the first live row"); empty-playlist rows are caught by the watchdog ×3 with notices; give-up lands paused with the drawer open (`POISON_REFUSED`/`POISON_EMPTY` hooks; `AUTOPLAY_MODE=All` drives the live-feed path).
- **MacStream — a native macOS streaming client (`macapp/`).** A SwiftUI app that browses the server (Discover trending, Search, per-title detail with season/episode picker and the aggregated stream rows) and plays video **inside the app window** — no external player, no second window. Video renders through libmpv's render API (`vo=libmpv` + `mpv_render_context` into a `CAOpenGLLayer`); `--wid` embedding was abandoned because a reparented NSView never renders again, and the render API was the only route to in-window playback. All mpv control calls run on a serial background queue — waiting on mpv from main is what used to beachball — and teardown frees the render context (GL context current) before the core, off-main.
  - **The player pane is pinned at the window root, above the `NavigationSplitView`** — this is load-bearing, not a styling choice: an `NSViewRepresentable` inside the split view's detail column never gets a window at all (SwiftUI never commits the host to the tree), which presented as "attach gave up: view never got a window" after a 3s retry. Root-level overlay attaches on the first attempt.
  - **Resume and row switches carry position** via mpv's per-file `start=` option (`loadfile <url> replace start=<sec>`), so the first frame lands at the saved position — Continue Watching resumes where it stopped, and switching rows mid-playback (including a stall-driven switch) continues at the same timestamp instead of restarting.
  - **Continue Watching** persists to `~/Library/Application Support/MacStreamApp/continue-watching.json`, flushed every 10s while playing and on stop (a position saved only on clean exit is a position lost on crash), dropped at ≥95% or <15s.
  - **Stalls offer, don't auto-switch**: a picture that freezes for 15s mid-play raises a banner — "Switch to next row (⏎) / Dismiss (⎋)". End of file is not a stall (pos parked at the duration), and a paused player never triggers the offer.
  - Keyboard: Space, ←/→ (Shift: 60s), ↑/↓ row switch, 1–9 direct row, `[`/`]` episodes across season boundaries, `f` fullscreen, `m` mute, `?` help, Esc dismiss → fullscreen → stop; all pass through when ⌘ is held or a text field/slider/table/button has focus.
  - Headless verification hooks (documented in `macapp/README.md`): `AUTOPLAY` (+ type/id/season/episode knobs), `STOP_AFTER`, `RELOAD_AFTER`, `SWITCH_AFTER`, `EPISODE_NEXT_AFTER` — these drove the test runs that verified attach, playback, stop→rebuild cycles, mid-playback row switch with position carry, the stall offer, and the S1E10→S2E1 season-boundary crossing end-to-end.
- **MacStream redesign — Netflix/Disney-style native app.** The client was rebuilt around a full-window player and a true-black theme.
  - **Detail pages are hero screens**: full-bleed backdrop fading to black, bold title, meta row, genre chips, tagline, and one white Play/Resume button (Resume when a saved position ≥15s exists, captioned with the timestamp). Streams load quietly in the background with a “N streams ready” caption; the stream list was removed from the detail page.
  - **The player occupies the whole window** (the `f` fullscreen toggle is gone — there is nothing to toggle), with transport controls that auto-hide after 3.5s and re-reveal on hover, click or any state change. A spinner covers the entire stream fetch (“Finding streams…”) and reappears whenever mpv is cache-idle while playing.
  - **Backing out of the player goes to a mini-player**: one persistent `PlayerSurface` at the window root whose frame shrinks to a floating 400×225 card at the bottom-trailing corner — playback continues while you browse (never branch the hierarchy around the representable; re-creating it tears mpv down). Click the card to expand, ✕ to stop and save position, Esc to stop.
  - **Manual stream override moved into the player**: a hover-revealed right-side drawer (`s` or the Streams button) listing quality · provider · language · MKV badge · source title/size, with a checkmark on the current row; switching preserves position.
  - **Rows that never start belong to the first-frame watchdog, not the stall offer** (an earlier iteration widened the 15s offer to cover them, but a dead row never freezes — it never paints). The watchdog now advances through up to 3 rows with notices and then gives up into the drawer; the stall offer covers only started pictures that freeze mid-play. End of file and paused players never trigger it; the policy remains offer-don't-auto-switch.
  - **True-black theming**: forced dark, black window/sidebar/detail/settings (`WindowConfigurator` NSViewRepresentable), no macOS gray or translucency, neutral-white accent tint.
  - **Real Dock app bundle**: `macapp/Scripts/make-app.sh` release-builds `MacStream.app` (Info.plist, generated black-tile/white-play-triangle icon via `make-icon.swift` + `iconutil`, ad-hoc signed) and installs to `/Applications`.
  - **Keyboard updated**: Esc now runs stall-dismiss → watching→mini → mini→stop; `s` toggles the drawer; while watching, the hidden browsing UI's focused responder can no longer swallow player keys (the pass-through guard applies only in mini mode).
  - **Headless hooks extended**: `OPEN_DETAIL`, `RESUME_FIRST`, `MINI_AFTER`, `EXPAND_AFTER`, `STREAMS_AFTER` — these verified the hero page, direct-to-player resume at the saved position, the full→mini→full frame round-trip (`1920×1118 → 400×225 → 1920×1118` with mpv rendering throughout), the drawer, hover/auto-hide in every mode, and the stop→rebuild cycle.
- **Stream tags (`utils/streamTags.js`).** Every stream now carries `tag` (`anime` | `movie` | `tv`), `tags` (array form) and `tagSource` (which source said so). Streams from `providers/anime.js` are **always** tagged `anime`, stamped in `providers/registry.js` so no route can forget; every other provider is classified through TMDB exactly as before (`isAnime` → `anime`, otherwise the media type), so a mirror's stream for an anime title groups with the anime ones. `tagSource` keeps the two apart: `provider` | `tmdb` | `request`. A stream is never tagged on a guess — if TMDB did not answer, only the media type is claimed. Both stream endpoints also return a `tagCounts` summary.
- **Uniform episode metadata on every stream, from one source of truth** (`utils/streamMeta.js`). The same episode was being described three different ways because each provider built its own title string: the anime provider said `Auto | ONE PIECE (1999) S21E1`, CastleTV said `One Piece S21E01 (1999) 1080p | 2.05 GB | Castle`, and only DahmerMovies carried the real episode name — because that site put it there. The canonical name was already in the response one level up, just never copied down onto the streams. Every stream now gets:
  - `title` — **the episode name**, truncated to 60 chars (`The Land of Wano! To the Samurai…`). Set only when we actually have a name, so a movie, or an episode TMDB has not named, keeps the provider's own title. A title is never blanked.
  - `sourceTitle` — the provider's original title, verbatim, so replacing it costs nothing: `4.8 GB | Remux AAC 2 0` and `2.05 GB | Castle` survive there.
  - `episodeName` (untruncated), `description`, `still`, `airDate`, `absoluteEpisode`.
  - `track` / `language` / `languageLabel` — for the anime provider's `sub` → `ja`/Japanese and `dub` → `en`/English. `null` for providers that don't declare a track, rather than guessed. This is the **audio** track and is deliberately separate from the existing `subtitles` field.
  
  Applied centrally in the API rather than inside each provider, so CastleTV and the anime provider return byte-identical metadata for the same episode, and a provider added later inherits it for free. Costs no extra upstream requests — it reads metadata the response has already fetched.
- **`scripts/verify-stream-meta.mjs`** — 26 checks that the fields are uniform, that `sourceTitle` preserves provider wording, that language mapping is right and unknown is never guessed, and that a title is never blanked.
- **`public/test-player.html` is now a general harness, not a single hardcoded title.** It was fixed to One Piece S21E1 (TMDB 37854), which meant checking an anime series was free and checking anything else meant editing the file. It now takes a **type (TV/anime series or movie), a TMDB id, and season/episode**, hides the season and episode fields for a movie (and omits the params, which the API rejects without both), and has one-click presets across anime, TV and films. Bad input is refused in the page before a request is sent rather than becoming a 20s round trip to a 400, and **"Fill from TMDB ID"** asks the API what the id actually is — so a wrong type or a stale season number is corrected before you wait, instead of after.
  - It answers the three questions that were previously spread across three places, all at once: **how fast** (a big ms figure, plus `stopReason`, so a deliberate early return is not mistaken for a timeout), **which sources** contributed (a lone provider is flagged inline as "no redundancy if it goes down", which is the reliability question the coverage matrix answers in bulk), and **whether all the data arrived** — a per-field checklist, so "it worked but has no description" is visibly different from "it fully loaded". For a movie the series-only fields are shown neutral rather than as failures.
  - **`scripts/verify-test-player-ui.mjs`** — 20 checks that drive all of this in jsdom: an anime series, a movie, local input rejection, and the presets.
- **The Load button used to be disabled for the duration of the request**, so an 8-second load left you unable to ask for anything else, and a hung provider left you stuck entirely. Superseded responses were already discarded by the load token, so re-requesting was always safe; the button now stays live.
- **`scripts/verify-coverage.mjs`** — sweeps a fixed 26-title catalogue across 12 categories (blockbuster, classic, obscure, anime film, foreign, recent, popular series, anime, long-run, kids, sports, older show) and reports coverage *per category*, latency percentiles, and — the number that matters for reliability — which titles rest on a **single provider**. Written because the per-provider smoke test cannot see this failure: when a whole category has no source, every provider individually reports `empty`, which looks identical to "the sites are fine, this title just isn't carried". That reads as "the app is broken" to a user and as nothing at all in the logs.
- **`scripts/verify-earlyexit.mjs`** — 20 checks on the early-return rule, with most of them on the threshold that stops it becoming a bad early exit (40 streams from one provider must still be refused).
- **Aggregate soft deadline.** `GET /api/streams/:type/:tmdbId` leaves after `AGGREGATE_SOFT_DEADLINE_MS` (default 20000) with whatever has arrived, instead of waiting for the slowest provider: `partial: true`, `pending: [...]`, and `providerStatus` entries of `pending`. Override per request with `?deadline=ms` (clamped to 2s–the hard per-provider ceiling) or globally with the env var. A client that wants everything can ask for the full budget; a client that wants to render now does not have to.
- **`timings` on the aggregate response** (`totalMs`, `providersMs`, `imdbMs`, `metadataMs`, `deadlineMs`, `settled`/`providerCount`) so "the API is slow" can be answered with numbers. The anime provider also logs its per-source durations on its summary line.
- **`public/test-player.html`** — a single-purpose playback check for One Piece S21E1 (TMDB 37854, absolute #892). Enter nothing: it loads the aggregate on open and lists every stream with a Play button, its type (HLS / file / MKV), provider, quality and tag, plus a log that reports load times and the actual failure reason. MKV rows are disabled with the reason stated rather than offering a button that silently fails. It exists to answer one question — "does this play in a browser" — so it uses the API's own origin for requests and does not race, retry or remember timings.
- **`scripts/verify-test-player.mjs`** — drives that page in jsdom against a live server and asserts every proxied stream is labelled HLS, which is the regression that broke playback.
- **`scripts/verify-classify.mjs`** — unit-tests the page's URL classification across all 12 shapes the API can return (proxied/direct × m3u8/mp4/webm/mov/mkv/extensionless/unknown), including the proxied-playlist case that caused the bug.
- npm scripts: `verify:numbering`, `verify:classify`, `verify:streams`, `verify:player`, and `verify` for all four.
- **`utils/episodeNumbering.js`** — one shared implementation of "what number is this episode", replacing four that disagreed (`utils/metadata.js`, `apiServer.js`, `providers/anime.js`, `providers/onetouchtv.js`). Exposes `classifySeason`, `resolveNumbering`, `countsFromSeasons`, `absoluteOffset` and `absoluteFromCountsArray`.
- **`utils/anilist.js`** + **`utils/metadata.js`** — a shared AniList service (romaji/English/native titles, description, artwork, genres, score, studios, `idMal`, episode totals; 6h cache, single-flight, degrades to `null`) and a merge layer that answers "what is this title, and what is this episode" from TMDB + AniList together.
- **`GET /api/metadata/:type/:tmdbId`** and **`GET /api/metadata/:type/:tmdbId/episodes`** — title screens and episode pickers without a second TMDB integration. Episode responses now carry `numbering`, `numberingBase`, `totalEpisodes`, `anilistTotalEpisodes` and `warnings`.
- **`scripts/verify-numbering.mjs`** — `node scripts/verify-numbering.mjs [--live]` checks the numbering rules offline and, with `--live`, against real TMDB/AniList data.
- Stream responses now include merged metadata for series (previously movies only), plus `absoluteEpisode`, `numbering` and `numberingWarning`.

### Fixed
- **Anyone who could reach the server could reconfigure it, and read out its secrets.** `POST /api/config` had no authentication, and `saveConfigPatch` merges the submitted patch with **no key whitelist** (`{...currentOverride, ...patch}`) — so anyone on the network could set `enableProxy: false` or `minQualities: "2160p"` and silently break playback for everyone using the server. Both `GET` and `POST` also returned the merged config verbatim, which included the **TMDB API key and the FebBox cookie in plaintext**. Writes now require a session (`401 AUTH_REQUIRED`), reads return masked values plus `hasTmdbApiKeys` / `hasFebboxCookies` so a UI can still show that a value is set and replace it, and `/api/debug/env` (which leaked a cookie prefix) is behind a session too. `/api/restart` was already protected — this was the outlier.
- **A nonsense season/episode silently returned a different episode.** `Number('abc')` is `NaN`, and `NaN` is falsy, so the providers' `seasonNum || 1` fallback turned `?season=abc&episode=xyz` into **season 1 episode 1**: 16 streams for a completely different episode, reported as `success: true` with no warning and `metadata.episode: null`. This is the exact wrong-episode failure the numbering work exists to prevent, arriving through the front door. Season and episode are now validated once in `apiServer.js` (strict integers, season ≥ 0, episode ≥ 1, both or neither) and rejected with `400 INVALID_SEASON_EPISODE` across all four routes that accept them.
- **vixsrc parsed the audio language and threw it away.** `parsePlaylist` built an `audioTracks` array from `#EXT-X-MEDIA:TYPE=AUDIO` (`LANGUAGE=`/`NAME=`) and then returned only `{ sources, subtitles }`. It is now returned and attached, with `jpn`→Japanese / `eng`→English, plus the full `audioTracks` list for genuinely multi-audio manifests.
- **castletv had the language and only used it as a display label.** `track.languageName` was flattened into a `[English]` prefix in the stream name and never emitted as a field, so castletv reported no language while the anime provider did. It is now a structured `language` / `languageLabel`.
- **Language codes were only recognised in their three-letter ISO 639-2 form**, so a manifest saying `pt-BR` (two-letter) resolved to nothing. Both forms are accepted now, along with the full names. Caught by the new tests.
- **A test that reported correct behaviour as broken.** `scripts/verify-streams.mjs` used a 25s client timeout while the server guarantees 45s, so slow-but-working providers (4khdhub was measured anywhere from 5s to 161s of its own work) were reported as "did not respond". The client now waits longer than the server promises, so a timeout there means something.

### Changed
- **The aggregate waited the full deadline even when the answer was already complete.** A 26-title sweep across 12 media categories measured a **median of 12,647ms and a p90 of 17,821ms**, and almost all of it was spent waiting on stragglers long after 30+ playable streams were already in hand — dahmermovies alone accounted for 7.1s of a Better Call Saul request that returned 2 streams either way. The soft deadline is a "too long" limit, not a target. The response now returns as soon as it holds `AGGREGATE_ENOUGH_STREAMS` (12) from `AGGREGATE_ENOUGH_PROVIDERS` (**3**). Same sweep after: **median 2,260–2,547ms, p90 6,291–6,849ms**, coverage unchanged at 26/26. The provider-count half is the point, not an afterthought — a stream count alone is satisfied by three providers returning one stream each, which is three chances to be wrong and would defeat the reason for aggregating 14. `stopReason` now reports `complete` | `enough` | `deadline` so a deliberate early return is never mistaken for a timeout; `&wait=1` opts out. Logic lives in `utils/earlyExit.js` with 20 checks in `scripts/verify-earlyexit.mjs`.
- **4khdhub re-validated every stream link on every request** — one HEAD request each, ~20 links per episode, 14s of the budget. Its links are presigned with an 8-hour expiry, so a link that validated once is still good next time; validations are now remembered for an hour (`4KHDHUB_VALIDATION_CACHE_MS`, bounded at 5000 entries). Failures are deliberately **not** cached: a 403 there is nearly always an expired signature or a host blocking HEAD, and remembering it would suppress a good link long after it recovered. Partial win — the remaining ~10s is link *resolution*, not validation.
- **Responses are compressed.** A stream list is the most-requested payload here and was going out uncompressed. Measured on One Piece S21E1: **34,197 → 4,886 bytes over the wire (86% smaller)**. Media and segment traffic is excluded — re-compressing bytes the proxy already streams would burn CPU for nothing.
- **The per-episode metadata is no longer repeated on every stream.** `description`, `still`, `airDate`, `episodeName` and `absoluteEpisode` are identical on all streams and measured at **28% of the payload** (~9.7KB of 34KB for 20 streams). They are now served once at `metadata.episode` (and as a new top-level `episode` object on the per-provider route), and `?perStreamMeta=1` restores the previous per-stream shape for any client that needs it. The keys remain present-and-null by default, so a client reading `stream.description` never throws. That is not merely slow: providers like 4khdhub parse multi-megabyte pages with cheerio, and CPU-bound work on Node's single thread **stops all timers firing** — including the aggregate's own soft deadline. Measured with 8 users: the deadline configured for 20,000ms fired at **108,136ms**, six of eight users hit a 60s client timeout, and `/api/health` degraded from 4ms to 474ms. The safeguard meant to return early instead of hanging could not fire, because the loop it depended on was blocked. Provider work is now admitted through a semaphore (`utils/concurrency.js`, default 28 — above one request's provider count so a single user is never slowed). Same load now: **16 users × 3 rounds, zero timeouts, zero errors, event-loop lag p95 of 27ms**, `/api/health` steady at 6–8ms.
- **One upstream failure was amplified into fourteen.** `utils/tmdb.js` cached successes but not failures, so when TMDB answered one caller with 429, the other ~13 providers each retried immediately — and those retries are what kept the limit active. Observed live as six providers reporting `network timeout at api.themoviedb.org` on a single request. Failures are now negatively cached for 30s (so the other callers fail fast instead of piling on), a 429 triggers a process-wide cool-off that honours `Retry-After`, and held-off lookups reject immediately rather than hanging. Measured: 14 concurrent lookups against a failing TMDB now make **1** upstream call instead of 14.
- **Cross-user data leak in the showbox provider.** Per-request state lived on `global.currentRequestConfig` — a single slot shared by the whole process. Two users requesting at the same time overwrote each other's FebBox cookie mid-request, and `global.currentRequestUserCookie` was **never cleared at all**, so a cookie chosen for one user stayed readable by every later request. Replaced with `AsyncLocalStorage` (`utils/requestContext.js`), which is per-request rather than per-process and is discarded automatically when the request ends, so there is no cleanup path to forget on an error or timeout.
- **Every cache was unbounded.** All nine caches (`utils/tmdb.js`, `metadata.js`, `anilist.js`, `cinemetaEpisodes.js`, `tmdbTitleToImdb.js`, `providers/anime.js`, `netmirror.js`, `onetouchtv.js`, `streamflix.js`) were bare `new Map()`s with a TTL but no size limit, and entries were only removed when read *after* expiry — so a title nobody asked about again stayed in the heap forever. On a server browsed like a catalogue that is a slow climb into GC-thrashing, which shows up as random latency spikes and finally an OOM kill. All now use `utils/boundedCache.js` (TTL + hard ceiling + oldest-first eviction).
- **The login rate limiter leaked.** `loginAttempts` only shed an entry when the *same* IP came back after its window, so a scan from many addresses grew it without limit. Now capped at 10,000 tracked IPs, oldest windows evicted first.
- **The proxy opened an unbounded number of sockets.** `node-fetch` opened a new connection per request, so N simultaneous viewers meant N TLS handshakes and eventually exhausted ports and file descriptors. The proxy now shares a bounded keep-alive pool (`PROXY_MAX_SOCKETS`, default 64; `DISABLE_KEEPALIVE=true` restores the old behaviour), which queues rather than refusing, so a spike degrades into waiting. Note for anyone editing this: do **not** add `timeout` to the agent options. An `http.Agent` timeout only *emits* a `timeout` event, it does not abort the request, so every proxied fetch hangs forever instead of failing — measured as a manifest that took 645ms direct and never returned through the proxy. `freeSocketTimeout` is the safe variant.
- **The anime provider probed every link it found at once** (`Promise.all` over ~20 links) — the specific provider still running when the soft deadline fired. Now a bounded pool (4 at a time) over at most 12 links, which is more than any player needs to choose from.
- **A malformed showbox share could blank out a whole title.** `streamsFromThisShareInfo.push(...tvStreams)` threw `tvStreams is not iterable` when the inner function finished without returning an array, discarding every other stream that share had found. Now guarded.
- **Video took 3–8s to start, and sometimes never appeared.** Not a codec or CDN problem: serving a variant playlist fired a background prefetch of **every segment in the episode at once** (`Promise.all` over the whole list — 354 segments measured on One Piece S21E1). That saturated the upstream, so the player's own request for the *first* segment queued behind 353 strangers. Measured on the same request: **11,440ms while the prefetch was running vs 43ms on an idle server**, a 265× difference, and it varied wildly (one run took 22s). Prefetch is now a 2-worker queue over the first 4 segments only, and it stands down entirely while a genuine player request is open. Time to first frame: **9,492ms → ~1,700ms cold, ~800ms warm**, and no longer degrades under load. `proxy/proxyServer.js`.
- **The real player could still stall on the slow-start path.** `player.html` created its HLS instance without `startFragPrefetch` at the actual playback attach point (it had it on the probe path), so every stream paid for level selection before the first fragment was fetched.
- **The test player could report a failure against the wrong provider.** Video listeners were attached per click inside `play()` with a `once:true` closure over that click's stream. A stream that neither loaded nor errored left its listener attached, so the *next* stream's error was also printed under the *previous* provider's name — actively misleading when the purpose of the page is to identify which source is broken. Listeners are now installed once and read the currently-playing stream. `public/test-player.html`.
- **Healthy streams logged a bogus "autoplay blocked" warning.** `v.play()` was called before the manifest was parsed; the rejected promise was reported as an autoplay problem even though nothing was wrong. Play is now requested on hls.js `MANIFEST_PARSED`.
- **A dead source spun forever with no explanation.** Added a 20s no-first-frame watchdog that names the provider and says the source is stalled or dead, plus plain-language media error codes (`network error` / `decode error` / `source not supported`) instead of bare numeric codes.
- **Rapid Reload clicks could render stale results** from an out-of-order response; the loader now discards an answer that a newer request has superseded.
- **The test player never played anything.** It detected HLS with `/\.m3u8/`, but with `enableProxy` on the API rewrites every stream to `<origin>/m3u8-proxy?url=...`, and `m3u8-proxy` has **no dot** before `m3u8` — so the test never matched. Every stream was handed to `<video src>` as if it were a progressive file, and Chrome cannot decode HLS that way. Measured on One Piece S21E1: **0 of 20 streams** were recognised as HLS. Symptom was a player with controls, `0:00` and no error. `public/test-player.html` now uses the same `isHlsUrl()` that `public/player.html` and `public/resolver.js` already carry (documented there as "INTEGRATION NOTE A"), and it is worth noting that the same trap also breaks stream *ranking* and `.mkv` detection, not just playback.
- **Wrong absolute episode numbers for standard-numbered anime.** TMDB uses one field, `episode_number`, for two different schemes: it continues across seasons for long runners (One Piece S21 starts at 892) but restarts at 1 for everything else (Attack on Titan S2 starts at 1 yet is absolutely #26). Reading it as "the absolute number" meant Attack on Titan S2E1, Breaking Bad S2E1 and Demon Slayer S2E1 were all resolved to #1 — the wrong episode. The season's scheme is now detected from its own numbering and the absolute number derived accordingly (`apiServer.js`, `utils/metadata.js`, `providers/anime.js`).
- **`providers/anime.js`**: absolute numbering now delegates to `utils/episodeNumbering.js`, so the stream label and the metadata endpoint can no longer disagree.
- **`providers/onetouchtv.js`**: absolute episode resolution delegates to the shared helper, which returns `null` instead of guessing when an earlier season's episode count is unknown.
- **AniList matches could be a different title entirely.** `findByTitles` returned the first title spelling that produced *any* result, so TMDB's "Naruto Shippūden" (accented) resolved to the film *NARUTO: Blood Prison* and live-action shows picked up unrelated anime ("The Office" → *Survival in the Office*). Every spelling is now searched and all results scored together on an F-score over words, format and year; live action requires a near-exact title, since a loose match against an anime-only database is a coincidence.
- **`apiServer.js`**: a timed-out provider returned a `ReferenceError` for `imdbId` instead of the intended `PROVIDER_TIMEOUT` body, because the id was scoped inside the `try` block the `catch` was reporting on.

### Changed
- **The aggregate is no longer as slow as its slowest provider.** Measured cold-cache wall-clock went from 18.8-26.1s to 13.2-17.0s, and the anime provider's anixo sweep from 13-25s to ~3-7s. Three causes, all fixed rather than papered over with a longer timeout:
  - `providers/anime.js` ran anixo's 2 tracks x 4 servers as a nested loop of page-load + resolve, 16 requests **one after another**, while every other source sat idle. It now probes one ticket per track (2 requests) and then resolves the pairs with a concurrency of 2. The pairs are independent — each mints its own single-use ticket — so this is a pure win: measured over four runs, serial = ~6.0-7.3s/16 links, limit 2 = ~2.7-3.2s/16 links. Concurrency 4 was measured too and **rejected**: anixo answers `HTTP 429` and drops mirrors (16 links becomes 7-8). Faster here means fewer playable mirrors, which is a worse outcome, so the limit is deliberately 2 and commented as such.
  - `providers/4khdhub.js` resolved its redirect URLs in a serial `for` loop with an `await` per link (a movie lists a dozen), spending 16-24s mostly on idle sockets. Now bounded-concurrency with input order preserved, which the cache below it depends on.
  - `apiServer.js` awaited the TMDB→IMDb lookup *before* invoking any provider, putting a round trip in front of every provider call for a value no provider reads from the context (each resolves its own ids through the same cached lookup). It now runs in parallel and is only awaited when the body is built.
- **`utils/tmdb.js`** deduplicates concurrent lookups (single-flight). A dozen providers asking for the same title's details in the same instant used to each miss the cache together and fire their own TMDB request; they now share one.
- **`providers/zxcstreams.js`** short-circuits for 3 minutes when discovery has genuinely failed *and* no server answered — that combination costs ~18s to rediscover (portal timeouts, subdomain probes, then four calls against a dead base). Any success clears it immediately, and running out of our own time budget never marks the site down, because a slow title says nothing about the site's health. Also fixes a mis-measured case: `getBase()` stamps its cache timestamp even on the fallback path, so the new `_discoveryFailedAt` flag is what actually distinguishes "discovered" from "gave up".
- AniList total episode counts are used to sanity-check TMDB's season table, and disagreements are reported as `numberingWarning` / `warnings[]` rather than being silently resolved. AniList frequently models a show as one entry per cours (Attack on Titan, Demon Slayer, My Hero Academia) where TMDB has a single series, so a gap usually means the two disagree about the show's *shape*.

### Removed
- **Four providers: `vixsrc`, `videasy`, `hdghartv`, `zxcstreams`.** The 2026-10 audit probed every registered provider against six titles (The Dark Knight, Fight Club, The Backrooms, One Piece S21E1/S22E45, Game of Thrones S8E3) and these four returned **0 streams on every single one** — HTTP 200 with an empty list, no error surfaced to the caller. Root causes, confirmed by invoking each provider directly: vixsrc and hdghartv are behind Cloudflare challenges (the API returns `Just a moment…` HTML / a 302 challenge page instead of JSON), videasy's seed backend `api.speedracelight.com` answers 502, and zxcstreams' token endpoint 403s with its own discovery logic reporting "all discovery methods failed". Their upstreams are not coming back without a Cloudflare-bypass subsystem, and silent-empty providers inflate the aggregate's settle time while adding a retry-shaped nothing to every response. The other ten providers (including the default `4khdhub` and the `anime` provider) all answered on their applicable titles. **`parsePlaylist` survived**: it is a pure HLS manifest parser exercised by `scripts/verify-stream-meta.mjs`, and now lives in `utils/hlsPlaylist.js`.

## [1.3.0] - 2026-08-19

### Added
- **7 new providers ported from the Infinite-streams v5.0.0 Stremio addon** (CommonJS ports, registered in `providers/registry.js`):
  - `streamflix` - StreamFlix direct MP4 links (30-min `data.json` cache + Firebase episode lookup).
  - `vaplayer` - VaPlayer HLS streams resolved by IMDb ID.
  - `castletv` - CastleTV streams via AES-128-CBC encrypted API (`api.hlowb.com`), per-track + shared fallback, subtitle support.
  - `hdghartv` - HDGharTV title search with fuzzy match + IMDb ID verification, quality-sorted links.
  - `netmirror` - Netflix direct (embed-tmdb) plus NewTV platform fallback (Netflix/Prime Video/Hotstar/Disney) with rotating discovery domains.
  - `onetouchtv` - OneTouchTV streams via AES-256-CBC custom-base64 API (title/season matching + IMDb verification + absolute-episode resolution).
  - `zxcstreams` - ZXCStreams multi-server backend (icarus/berkas/orion/athena) with dynamic domain discovery and shared-token flow.
- **New shared utilities**: `utils/titleMatch.js` (fuzzy title matching port), `utils/tmdbTitleToImdb.js` (TMDB title→IMDb resolution with cache), `utils/cinemetaEpisodes.js` (episode counts per season).
- **Configurable provider-check TMDB ID**: the title used by dashboard functional checks is now editable in the Server Status panel (default `278`, env `PROVIDER_CHECK_TMDB_ID`). Persisted via `POST /api/config`, reset via Clear All, and exposed through `/api/status` as `providerCheckTmdbId`.

### Fixed
- **Vidlink provider**: Rewritten for the new API format — parses `stream.qualities` into one stream per quality (best-first), no longer relies on the removed HLS proxy format. Requires a working CDN (some CDNs 429 server-side requests from blocked IPs; browsers play direct URLs fine).
- **`utils/tmdb.js`**: Now reads the TMDB API key via `utils/tmdbKey` (normalized `tmdbApiKeys`) instead of the deleted legacy `config.tmdbApiKey` field, so `getDetails`/`resolveImdbId` work with the current config schema.
- **castletv quality parsing**: Quality is now parsed from `resolutionDescription` (SD 480P / HD 720P / FHD 1080P); streams are deduped per URL keeping the highest resolution (eliminates the "2024p" year-match bug).
- **docker-compose.yml**: Fixed broken YAML indentation on the `BIND_HOST` environment entry that prevented `docker compose up` from parsing.

### Changed
- Version bumped to **1.3.0** across `package.json` and `package-lock.json`.
- `.env.example` refreshed to the current schema (`API_PORT` instead of legacy `PORT`, placeholder TMDB key, documented multi-key JSON array).

### Documentation
- **README fully rewritten** to match the current project state: 13-provider list, accurate authentication docs (`utils/auth-users.json`, default `admin` / `change-me`), corrected environment variable table, complete endpoint + proxy route reference, plugin example mirroring the real `providerFunctionMap`, and a new "Server Status & Functional Checks" section.

---

## [1.2.0] - 2026-08-19

### Removed
- **LordFlix provider**: Permanently removed — upstream API `snowhouse.lordflix.club` (and `lordflix.org`) no longer resolves in DNS. `enc-dec.app` is a passthrough signer and returns signed URLs for the dead host; no compatible successor API exists (`lordflix.gd` / `lordflix.app` are unrelated clones using TMDB-ID + iframe embeds, not the snowhouse API).
- **NoTorrent provider**: Permanently removed — taken down by its developer; the Stremio addon API bridge (`addon-osvh.onrender.com`) is no longer available.

---

## [1.1.1] - 2026-05-29

### Removed
- **MoviesMod provider**: Permanently removed — `moviesmod.farm` returns HTTP 403 with Cloudflare managed challenge (`cf-mitigated: challenge`). No server-side workaround exists without a browser runtime.
- **VidZee provider**: Permanently removed — hardcoded AES-256-GCM salt is no longer valid against VidZee's current API key blob, causing all decryption to fail.

### Fixed
- **LordFlix provider**: Updated upstream domain (`network.hasta-la-vista.site` → `snowhouse.lordflix.club`) and refreshed server list (10 servers).
- **Docker startup crash**: Added missing `COPY proxy ./proxy` to both build and runtime stages in `Dockerfile` — `apiServer.js` unconditionally requires `./proxy/proxyServer` at startup.

---

## [1.1.0] - 2026-05-16

### Dependency Security
- **npm vulnerabilities fixed**: Upgraded `cheerio` (1.0.0 → 1.2.0) and `axios-cookiejar-support` (6.0.2 → 7.0.0) to eliminate 14 vulnerabilities (including `undici <=6.23.0` high/critical CVEs). Result: 0 vulnerabilities.

### Added
- **Videasy provider**: 10-server parallel scraper via enc-dec.app decrypt relay.
- **Vidlink provider**: Single-stream HLS source via enc-dec.app encode relay.
- **LordFlix provider**: 9-server scraper via enc-dec.app (replaces defunct Vidsync).
- **NoTorrent provider**: Stremio addon API bridge (`addon-osvh.onrender.com`).
- **DahmerMovies provider**: Open-directory direct file link scraper with proxy rewrite.
- **GitHub Sponsors button**: Official iframe embed in admin sidebar and README badge.

### Removed
- **Vidsync provider**: All 6 servers returned HTTP 401 — API locked. Replaced by LordFlix.
- **MP4Hydra provider**: Dead upstream, removed entirely.
- **UHDMovies provider**: Dead upstream, removed entirely.
- **vidsrcextractor.js**: Unused legacy file removed.

### Fixed
- **Provider enable/disable not working at runtime**: Removed the startup-time enabled/disabled filter. All providers are now always loaded into the registry array. `listProviders()` and `getProvider()` now call `isProviderEnabled(name)` which reads the live `config` object on every call. Changes take effect immediately without a server restart.
- **Showbox/FebBox provider**: Restored with correct `responseType:'text'`, AJAX headers, and double `ui=` cookie bug fix.
- **MoviesMod provider**: Updated class-based selectors and added support for `links.modpro.blog`, `cloud.unblockedgames.world`, `tech.examdegree.site`, and `driveleech.net` domains.
- **VixSrc provider**: Corrected to proper 2-step API flow.

---

## [1.0.9] - 2025-11-19

### Removed
- **Showbox/FebBox/PStream provider**: Permanently removed due to PStream API being protected by Cloudflare bot detection, making it inaccessible without complex proxy infrastructure
  - Deleted `providers/Showbox.js` and backup files
  - Removed FebBox cookie management from configuration panel
  - Removed `FEBBOX_COOKIES`, `SHOWBOX_CACHE_DIR`, and related environment variables
  - Cleaned up all Showbox-specific logic from provider registry
  - Removed FebBox/PStream configuration UI panel and related functions
- **Unused dependencies**: Removed 121 packages including puppeteer, patchright, puppeteer-extra, puppeteer-extra-plugin-stealth, and vm2 (~200MB+ saved)
- **Unused utility files**: Removed `cloudflareBypasser.js` and `jsunpack.js`

### Fixed
- **VidZee provider**: Updated to support two-stage AES decryption with dynamic API keys. The provider now fetches an encrypted key from `https://core.vidzee.wtf/api-key`, decrypts it using AES-256-GCM with a hardcoded key, then uses the result to decrypt video URLs with AES-256-CBC. Includes 1-hour API key caching for performance.
- **4khdhub provider**: Added support for `links.modpro.blog` domain (site migrated from `modrefer.in`).
- **moviesmod provider**: Added support for `links.modpro.blog` domain alongside existing `modrefer.in`.
- **uhdmovies provider**: Fixed domain to use `uhdmovies.rip` instead of outdated `uhdmovies.mov`. Added automatic domain replacement for stale scraped URLs. Created new `utils/linkResolver.js` utility to handle driveseed/driveleech download button extraction (supports Instant Download, Resume Cloud, Resume Worker Bot, Direct Links CF Type 1).
- **Provider registry**: Fixed `listProviders()` to return all available providers with their enabled status, not just enabled ones. Config panel now shows all 6 providers correctly.

---

## [1.0.8] - 2025-10-03

### Added
- Added `processStreamsForProxy` so the aggregate and provider-specific endpoints automatically rewrite stream URLs through the internal `/m3u8-proxy`/`/ts-proxy` layer whenever `enableProxy` is turned on, stripping provider headers safely.

### Changed
- Showbox provider overhaul: filesystem-only caching (Redis removed), smarter FebBox cookie selection with region fallbacks, TMDB title/image validation that recognises romanized names, plus cached HEAD size lookups for faster listings.
- Vixsrc provider rewritten to parse the `window.masterPlaylist` payload (token + expiry), returning a single master playlist with English subtitle lookup and correct Referer headers.
- Config loader now prefers `utils/user-config.json`, dedupes TMDB keys, defaults provider enable flags to `true`, and scrubs legacy proxy env values when mirroring overrides back to `process.env`.
- 4KHDHub provider permanently drops `.zip` archive links instead of trimming extensions and improves host distribution logging.
- Provider registry dynamically enumerates available modules (removing MoviesClub/Xprime remnants) while keeping per-request cookie stats for the admin debug panel.

### Removed
- Deleted legacy `providers/moviesclub.js`, `providers/xprime.js`, and other unused proxy/auth remnants that were no longer referenced.

### Fixed
- Aggregated responses now obey the proxy flag without client changes—streams returned from `/api/streams/...` are proxy-wrapped and omit upstream header hints when `enableProxy` is active.

---

## [1.0.7] - 2025-09-21

### Added
- VidZee provider: definitive AES-256-CBC decoder (replaced heuristic token attempts). Decodes newly obfuscated `atob(token) => ivBase64:cipherBase64` structure using padded key `qrincywincyspider` and PKCS7.
- Tail segment acceleration: internal tail prefetch map (`tailPrefetchMap`) with TTL cleanup and configurable `tailPrefetchKB` (default 256 KB) now documented and instrumented.

### Changed
- Proxy range negotiation: clarified interaction between `progressiveOpen` and synthetic initial partial (auto-suppression when progressive active). Additional debug logging around tail cache hits and forced host overrides.
- VidZee streams now always return direct decrypted URLs (per-stream `originalToken` retained for debugging when `VIDZEE_DEBUG=1`).
- Updated README version badge to 1.0.7.

### Fixed
- Eliminated edge cases where encoded VidZee tokens were leaking through without decoding.
- Reduced VLC initial loop behavior via tail prefetch serving last-byte probes from cache faster (combined with earlier 1.0.6 range logic).

### Notes
- Future proxy tuning items (size meta map, dynamic progressive growth) tracked but not part of this release.

---

## [1.0.6] - 2025-09-20

### Removed
- MoviesClub provider (multi-server scraping complexities & Turnstile challenge; deprecated permanently)
- Xprime provider (upstream Xprime.tv offline due to security changes)
- 4khdhub provider: all `.zip` archive links are now omitted entirely (previous releases experimented with stripping the extension which produced non-playable pseudo-MKV links)

### Added
- Structured multi-server debug instrumentation (session summaries, per-fetch metrics, pattern counters)
- Turnstile challenge detection & bypass attempt scaffold (synthetic `/rcp_verify` token posting)
- Optional internal stream proxy (`enableProxy` flag): mounts `/m3u8-proxy`, `/ts-proxy`, `/sub-proxy` with playlist + segment + subtitle handling and segment prefetch cache.
- Proxy range management features:
  - `clampOpen` (default on) – caps ambiguous open-ended `bytes=0-` requests to a bounded initial window (`openChunkKB`, default 4096 KB)
  - `progressiveOpen` (default on) – incremental expansion of the head range on successive `bytes=0-` requests instead of a single huge span
  - `initChunkKB` (default 512 KB) – size of the synthetic initial 206 response when neither clamp/progressive produce a range and `noSynth` is not set
  - `tailPrefetch` (default on) + `tailPrefetchKB` (default 256 KB) – asynchronous fetch & in-memory cache of the file tail to satisfy rapid VLC tail probes
  - `force200` (opt-in) – normalizes upstream 206 responses to 200 for diagnostics
  - `noSynth` (opt-in) – disables synthetic initial partial response generation
- Tail prefetch TTL cleanup task (30 min window) and in-memory maps for: segment cache, open range clamp, progressive growth, and tail buffers
- Host routing overrides: `pixeldrain.*` & `video-downloads.googleusercontent.com` are forced through `/ts-proxy` (extensionless or ambiguous content)

### Changed
- Centralized multi-server request headers with realistic `sec-ch-ua*` & `Sec-Fetch-*` values
- Added retry, rotating User-Agent, and cookie jar logic to multi-server fetch pipeline
- Showbox provider priority map updated after Xprime removal
- README/Docs trimmed to reflect current active providers only
- When `enableProxy` is active, stream response objects have their original `headers` field removed (proxy handles all required headers internally)
- 4khdhub provider now filters out archive endpoints instead of attempting extension normalization (prevents feeding ZIP files to players)
- Open-ended range handling improved to reduce VLC negotiation loops by throttling first-pass read size and growing progressively
- Synthetic initial partial response is automatically suppressed when `progressiveOpen` is active (real range growth preferred)

### Fixed
- Ensured multi-server fallback attempts (direct rcp player/m3u8 extraction) operate with improved diagnostics
- Eliminated repeated VLC tail probe stalls caused by archive masquerading as video content (root cause was filtered by dropping `.zip` URLs)

### Documentation
- Updated README version badge to 1.0.6 and provider list (removed MoviesClub & Xprime, clarified active providers list)
- Added proxy tuning parameter reference (clamp/progressive/tail prefetch, synthetic partial, force200) and host override notes
- Expanded explanation that per-stream headers are stripped when proxying is enabled

---

## [1.0.5] - 2025-09-19

### Improved
- 4khdhub provider: Permanently block `r2.dev` FSL links (previous optional flag removed).
- Added Referer/Origin headers automatically for FSL Server links during validation (prior to block enforcement ensured proper behavior).
- Tightened URL validation: removed unconditional trust for `r2.dev`; validation logic now consistent across hosts.
- Host distribution instrumentation logs final hostname counts for easier diagnostics.
- Preserved HubCloud worker `.zip` links by stripping the `.zip` extension instead of discarding them (enables direct playback attempts).

### Notes
- `r2.dev` links are always removed from final output; no env flag required.

---

## [1.0.4] - 2025-09-18

### Changed
- Unified stream object schema standardized:
  ```json
  { "title": "…", "url": "…", "quality": "…", "provider": "…", "headers": { } }
  ```

---

## [1.0.3] - 2025-09-17

### Fixed
- Server now binds to `0.0.0.0` by default so Docker port publishing works correctly from the host. Added `BIND_HOST=0.0.0.0` in Dockerfile and compose.

### Notes
- If you were seeing `ERR_CONNECTION_REFUSED` on `http://192.168.86.75:8787`, pull the latest image or rebuild, then re-run with `-p 8787:8787`.

---

## [1.0.2] - 2025-09-17

### Fixed
- Standardized Docker port to `8787` everywhere (Dockerfile `EXPOSE`, compose `ports`, healthchecks, and README examples). Previous release notes mentioned 8787 but some environments weren't reset; this release ensures consistency.

### Documentation
- Updated README version badge to 1.0.2 and verified Docker commands use `-p 8787:8787`.

---

## [1.0.1] - 2025-09-17

### Added
- Admin UI: Restart Server button (below Logout) with a themed confirmation modal. The UI polls `/api/health` and auto-reloads when the server is back.
- Sidebar divider under Logout/Restart for clarity.

### Changed
- Exclude Codecs presets:
  - Introduced "None" (default) → `{ "excludeDV": false, "excludeHDR": false }`.
  - "All" → `{ "excludeDV": true, "excludeHDR": true }`.
  - Persist and render presets reliably after Save / Reload.
- Minimum Quality: Clear All now resets to `"all"` and selects the All preset in the UI.
- Clear All: Now fully resets TMDB keys, FebBox cookies, providers, and filters; added a themed confirmation modal with optional "Don't ask again" preference.
- Live Config: Hide legacy `tmdbApiKey` (only show `tmdbApiKeys`).
- Restart behavior:
  - Local dev: Nodemon watches `restart.trigger`; backend writes it before a clean exit to force a restart.
  - Docker: Compose uses `restart: unless-stopped`; Docker restarts the container after restart endpoint triggers exit.
- Dockerfile: Ensure non-root `app` user owns `/app` for writing overrides and restart marker.
- package.json scripts: Simplified to `start`, `start:dev`, and `lint`; both start scripts are nodemon-based and watch `restart.trigger`.

### Fixed
- Provider matrix re-renders immediately after Clear All (no page refresh needed).
- Handling of Exclude Codecs "ALL" previously not persisting correctly.

---

## [1.0.0] - 2025-09-16
Initial stable release.

### Added
- Comprehensive `README.md` (features, endpoints, admin UI overview, screenshots gallery, Docker usage, troubleshooting).
- `LICENSE` (MIT) file.
- Multi-TMDB key rotation support (array of keys; random selection per request).
- Config override system writing to `utils/user-config.json` with live merged view.
- Session-based authentication (login, logout, session check, password change) with brute-force mitigation.
- Rate limiting + exponential lockouts for failed login attempts.
- Provider status & metrics endpoints: `/api/health`, `/api/metrics`, `/api/status`, `/api/providers`.
- Stream aggregation endpoints (aggregate + provider-specific) with filtering pipeline.
- Diagnostics instrumentation (intercept `process.exit`, `beforeExit`, unhandled rejection / exception logging, periodic heartbeat interval).
- Docker assets: multi-stage `Dockerfile`, `.dockerignore`, `docker-compose.yml` with persistent volume for overrides.
- GitHub Actions workflow (`.github/workflows/docker-publish.yml`) for automatic multi-arch (amd64+arm64) build & push on branch and tag (`v*`).
- OCI metadata labels and build argument (`VERSION`) in Docker image.
- Version + (placeholder) Docker pulls badges in README header.
- VidSrc extractor refactor: removed direct `process.exit` calls; `main()` now returns status code (safer when required as a module).

### Changed
- Config normalization now clears legacy single `tmdbApiKey` when `tmdbApiKeys` override is explicitly emptied.
- Dockerfile slimmed: narrowed COPY set, added labels, build arg, retained only necessary runtime artifacts.
- `.dockerignore` expanded to reduce build context (`.git`, logs, markdown except README, tests, CI configs, caches, compose file, etc.).

### Removed
- Deprecated `uhdmovies` provider: code file, registry references, UI toggles, documentation mentions.

### Security
- Hardened auth flow: session cookies (HttpOnly), no-store headers for admin pages, escalating lockouts against brute force.

### CI / Automation
- Added multi-arch Docker publish workflow using Buildx & QEMU.

### Documentation
- Added Docker usage section (local build, compose, multi-key usage, env vars table, healthcheck notes).
- Added screenshots gallery of admin UI.
- Updated docs to reflect provider removal and new configuration semantics.
- Added this `CHANGELOG.md`.

### Developer Experience
- Heartbeat diagnostic interval to aid investigation of unexpected exits.
- Intercepted premature `process.exit` calls to avoid silent shutdowns during debugging.

---

## Historical Context
This 1.0.0 release consolidates modernization work: provider cleanup, configuration clarity, deployment ergonomics (Docker + CI), security hardening, and observability.

---

[1.3.0]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.9...v1.1.0
[1.0.9]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.0...v1.0.1